import express from "express";
import { randomUUID } from "crypto";
import { LLM_URL, CHAT_MODEL, GROQ_API_KEY, MAX_TOOL_ITERATIONS } from "./config";
import { Message, IterationLog, NativeToolCall } from "./types";
import { retrieve, ingest } from "./rag";
import { buildToolPrompt, getToolSchemas, executeTool, tools, routeAgent, Mode, AgentType, SWITCH_TO_ACT_MODE, ACT_MODE_CONTINUATION_PROMPT, wantsAirbnbRecommendation } from "./tools";
import { logRequest } from "./db/sqlite";
import { profilePromptBlock } from "./profile";
import { handleTelegramUpdate, telegramSend, startTelegramPolling } from "./tools/telegram";
import { slackPostMessage } from "./tools/slack_monitor";
import { logConversation } from "./db/conversation-logger";
import { auditLog } from "./db/audit-logger";

// native structured tool-calling: the `tools` schema array is sent to the provider, which
// constrains the model's token sampler so it can only emit valid tool names/arguments —
// no text parsing, no escaping, no hallucinated tool names.
function normalizeToolCalls(rawCalls: any[]): NativeToolCall[] {
  return rawCalls.map((tc: any) => ({
    id: tc.id,
    function: {
      name: tc.function.name,
      arguments: typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments,
    },
  }));
}

// native structured tool-calling: the `tools` schema array is sent to the provider, which
// constrains the model's token sampler so it can only emit valid tool names/arguments —
// no text parsing, no escaping, no hallucinated tool names.
//
// We STREAM (stream:true) so response headers arrive immediately. With stream:false Ollama
// withholds all headers until generation finishes, and a cold model load (~30-60s to page
// 9.7GB into VRAM) plus generation blows past undici's default headers timeout — the first
// request after a model swap dies with UND_ERR_HEADERS_TIMEOUT. Streaming sidesteps that.
// How long to wait for the NEXT streamed chunk before giving up. Ollama occasionally wedges on a
// request (runner stuck at ~0% CPU, never generating) and, because it serves serially, a hung call
// blocks every later request too. Cline guards against this with a response-start timeout; we do the
// same but reset the timer on every chunk, so a call that is actively streaming is never interrupted.
const LLM_CHUNK_TIMEOUT_MS = 120_000;

async function llm(messages: Message[], toolSchemas: any[]): Promise<{ content: string; tool_calls: NativeToolCall[] }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (GROQ_API_KEY) headers.Authorization = `Bearer ${GROQ_API_KEY}`;

  const controller = new AbortController();
  let timer: NodeJS.Timeout = setTimeout(() => controller.abort(new Error(`LLM stalled: no data in ${LLM_CHUNK_TIMEOUT_MS / 1000}s`)), LLM_CHUNK_TIMEOUT_MS);
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`LLM stalled: no data in ${LLM_CHUNK_TIMEOUT_MS / 1000}s`)), LLM_CHUNK_TIMEOUT_MS);
  };

  try {
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 4000,
      tools: toolSchemas,
      stream: true,
    }),
  });
  if (!res.ok) throw new Error(`LLM error: ${res.status} ${await res.text()}`);
  if (!res.body) throw new Error("LLM error: empty response body");

  // Ollama streams newline-delimited JSON objects; accumulate content and capture tool_calls
  // (which arrive in whichever chunk the model emits them in). OpenAI/Groq stream SSE with
  // `data: ` prefixes and deltas — handled in the fallback branch below.
  let content = "";
  let rawCalls: any[] = [];
  let buf = "";
  const decoder = new TextDecoder();

  for await (const chunk of res.body as any) {
    resetTimer(); // actively streaming — push the stall deadline forward
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;

      // Groq/OpenAI SSE framing
      const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
      if (payload === "[DONE]") continue;

      let data: any;
      try { data = JSON.parse(payload); } catch { continue; }

      // Ollama native: { message: { content, tool_calls }, done }
      if (data.message) {
        if (data.message.content) content += data.message.content;
        if (data.message.tool_calls?.length) rawCalls = data.message.tool_calls;
      }
      // OpenAI/Groq delta: { choices: [{ delta: { content, tool_calls } }] }
      const delta = data.choices?.[0]?.delta;
      if (delta) {
        if (delta.content) content += delta.content;
        if (delta.tool_calls?.length) rawCalls = delta.tool_calls;
      }
    }
  }

  return { content, tool_calls: normalizeToolCalls(rawCalls) };
  } finally {
    clearTimeout(timer);
  }
}

// Cline-style stateful session: the conversation, agent type, and mode.
// agent (coding or general) is fixed at creation based on the first user message.
// mode (plan or act) only applies to coding sessions; for general agent it's always "act".
// Kept in memory — this is a local dev harness.
interface Session {
  messages: Message[];
  agent: AgentType;
  mode: Mode;
  includeProfile: boolean;
}
const sessions = new Map<string, Session>();

interface ChatOpts {
  includeProfile?: boolean;
  sessionId?: string;
  mode?: Mode;
}
interface ChatResult {
  response: string;
  sessionId: string;
  agent: AgentType;
  mode: Mode;
}

// stamp Cline's <user_input mode="..."> wrapper on coding messages so MODE_TAG_INSTRUCTIONS applies.
function wrapUserInput(text: string, coding: boolean, mode: Mode): string {
  return coding ? `<user_input mode="${mode}">\n${text}\n</user_input>` : text;
}

async function chat(userMessage: string, opts: ChatOpts = {}): Promise<ChatResult> {
  const { includeProfile = true, mode: requestedMode } = opts;
  const requestId = randomUUID();
  const requestStart = Date.now();
  const iterationLogs: IterationLog[] = [];

  // resolve or create the session
  let sessionId = opts.sessionId;
  let session = sessionId ? sessions.get(sessionId) : undefined;
  const isNew = !session;
  if (!session) {
    const agent = routeAgent(userMessage);
    session = {
      messages: [],
      agent,
      mode: agent === "coding" ? (requestedMode ?? "act") : "act", // general agent always "act"
      includeProfile,
    };
    sessionId = sessionId ?? randomUUID();
    sessions.set(sessionId, session);
  } else if (requestedMode && requestedMode !== session.mode && session.agent === "coding") {
    // only allow mode change for coding agent
    session.mode = requestedMode;
  }

  const { agent, mode } = session;
  const messages = session.messages; // work on the live array so state persists across requests
  auditLog(requestId, "user_input", { message: userMessage, sessionId, agent, mode, isNew });

  // RAG context only for general agent (coding agent doesn't use RAG)
  let chunks: Awaited<ReturnType<typeof retrieve>> = [];
  let context = "";
  if (agent === "general") {
    chunks = await retrieve(userMessage);
    auditLog(requestId, "rag_retrieval", {
      queryLength: userMessage.length,
      chunksRetrieved: chunks.length,
      chunks: chunks.map(c => ({ source: c.source, length: c.text.length })),
    });
    context = chunks.map((c, i) => `[${i + 1}] (source: ${c.source})\n${c.text}`).join("\n\n---\n\n");
  }

  // build the system prompt (messages[0]); refresh it every request so it tracks the current mode
  const systemContent = buildToolPrompt(agent, mode);
  if (isNew) {
    messages.push({ role: "system", content: systemContent });
    if (includeProfile && agent === "general") messages.push({ role: "system", content: profilePromptBlock() });
    if (agent === "general") messages.push({ role: "system", content: `Relevant context from your knowledge base:\n${context}` });
  } else {
    messages[0] = { role: "system", content: systemContent };
  }

  let outgoingUserMessage = wrapUserInput(userMessage, agent === "coding", mode);
  if (agent === "airbnb" && wantsAirbnbRecommendation(userMessage)) {
    outgoingUserMessage += "\n\n[REMINDER: this request wants recommendations, not just numbers. Call airbnb_api_recommend_top5(), NOT airbnb_api_stats(). Include each recommended listing's url.]";
  }
  messages.push({ role: "user", content: outgoingUserMessage });

  let toolSchemas = getToolSchemas(agent, mode);

  auditLog(requestId, "llm_messages_prepared", { messageCount: messages.length, contextLength: context.length, mode: session.mode });

  let finalResponse = "";
  let nudged = false; // reliability nudge (below) fires at most once per request
  let resultsSummaryAll = ""; // accumulates every tool result this request, for flow-completion checks

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const iterStart = Date.now();
    const { content, tool_calls } = await llm(messages, toolSchemas);

    if (!tool_calls.length) {
      iterationLogs.push({
        iteration: i,
        llm_input: [...messages],
        llm_output: content,
        tool_called: null,
        tool_params: null,
        tool_result: null,
        duration_ms: Date.now() - iterStart,
      });

      // reliability nudge: small models sometimes narrate approval ("sounds good, proceeding...")
      // without actually emitting the switch_to_act_mode tool call. Cline doesn't need this — its
      // target models follow the protocol reliably — but ours don't always. On a continuation turn
      // (a plan was already presented earlier in this session) that ends with no tool call, give the
      // model one explicit nudge instead of silently finishing in plan mode.
      if (session.mode === "plan" && !isNew && !nudged) {
        nudged = true;
        messages.push({
          role: "user",
          content: "If the user approved your plan, you MUST call switch_to_act_mode now to proceed — do not just describe it in text. If they did not approve or asked something else, respond in plain text only.",
        });
        continue;
      }

      // airbnb agent: the small model sometimes stops calling tools mid-flow and instead
      // narrates fake action JSON (```json {"action":"open_date_picker"}```) in plain text.
      // Those are NOT tool calls and do nothing. If we detect that shape before the flow is
      // done (airbnb_close never called), nudge once to use the REAL tools.
      const looksLikeFakeAction = /"action"\s*:/.test(content) || /```json/.test(content);
      const flowFinished = /airbnb_close/.test(resultsSummaryAll) && /airbnb_get_stats/.test(resultsSummaryAll);
      if (agent === "airbnb" && looksLikeFakeAction && !flowFinished && !nudged) {
        nudged = true;
        messages.push({
          role: "user",
          content: "You wrote action JSON as plain text — that does nothing. You must emit REAL tool calls using the airbnb_* tools provided to you. Look at the last tool result to see which step you're on, then call the NEXT airbnb_ tool in the sequence (open → search_destination → open_calendar → select_dates → click_search → scrape_page → get_stats → close). Emit exactly one real tool call now.",
        });
        continue;
      }

      finalResponse = content || "Done.";
      break;
    }

    messages.push({ role: "assistant", content: content || "", tool_calls });

    let switched = false;
    const resultsSummary: string[] = [];
    for (const tc of tool_calls) {
      // switch_to_act_mode is handled here, not in the tool registry, because it mutates session state.
      // Cline treats it as completesRun: flip to act, confirm, then auto-continue the approved plan.
      // (only for coding agent — general agent never uses this tool)
      if (tc.function.name === SWITCH_TO_ACT_MODE && agent === "coding") {
        session.mode = "act";
        const r = "You successfully switched to act mode, proceed with the plan. You now have access to editing files and running commands.";
        resultsSummary.push(`${SWITCH_TO_ACT_MODE}: ${r}`);
        messages.push({ role: "tool", content: r });
        switched = true;
        continue;
      }
      const result = await executeTool({ tool: tc.function.name, params: tc.function.arguments });
      console.log(`[tool-trace] iter ${i} CALL ${tc.function.name}(${JSON.stringify(tc.function.arguments)}) -> ${result.slice(0, 300)}`);
      resultsSummary.push(`${tc.function.name}: ${result}`);
      resultsSummaryAll += `${tc.function.name}: ${result}\n`;
      messages.push({ role: "tool", content: result });
    }

    iterationLogs.push({
      iteration: i,
      llm_input: [...messages],
      llm_output: content,
      tool_called: tool_calls[0].function.name,
      tool_params: tool_calls[0].function.arguments,
      tool_result: resultsSummary.join("\n"),
      duration_ms: Date.now() - iterStart,
    });

    if (switched) {
      // rebuild the session for act mode (new system prompt + full tool menu) and inject Cline's
      // synthetic continuation message so the model keeps going without waiting for new user input.
      messages[0] = { role: "system", content: buildToolPrompt(agent, "act") };
      toolSchemas = getToolSchemas(agent, "act");
      messages.push({ role: "user", content: ACT_MODE_CONTINUATION_PROMPT });
      continue;
    }

    if (i === MAX_TOOL_ITERATIONS - 1) {
      finalResponse = `Reached iteration limit after: ${tool_calls.map(tc => tc.function.name).join(", ")}`;
    }
  }

  auditLog(requestId, "request_complete", {
    totalDuration: Date.now() - requestStart,
    iterationCount: iterationLogs.length,
    finalResponseLength: finalResponse.length,
    finalResponsePreview: finalResponse.slice(0, 200),
    mode: session.mode,
  });

  logRequest({
    id: requestId,
    userMessage,
    retrievedChunks: chunks,
    iterations: iterationLogs,
    finalResponse,
    durationMs: Date.now() - requestStart,
  });

  console.log(`request ${requestId} done — ${iterationLogs.length} iteration(s), agent=${agent}, mode=${mode}, ${Date.now() - requestStart}ms`);
  return { response: finalResponse, sessionId: sessionId!, agent, mode };
}

// ---- server ----
const app = express();
app.use(express.json());

// POST /chat — { "message": "...", "session_id"?: "...", "mode"?: "plan" | "act" }
// Pass session_id to continue a conversation (required for the plan→approve→act flow); the
// response echoes session_id and mode so the client can carry them into the next request.
app.post("/chat", async (req, res) => {
  const { message, session_id, mode } = req.body;
  if (!message) {
    res.status(400).json({ error: "missing message" });
    return;
  }
  try {
    const result = await chat(message, { sessionId: session_id, mode });
    logConversation(message, result.response, "http");
    res.json({ response: result.response, session_id: result.sessionId, agent: result.agent, mode: result.mode });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
// POST /ingest — { "text": "...", "source": "..." }
app.post("/ingest", async (req, res) => {
  const { text, source } = req.body;
  if (!text || !source) {
    res.status(400).json({ error: "missing text or source" });
    return;
  }
  try {
    await ingest(text, source);
    res.json({ ok: true });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// POST /mcp — JSON-RPC 2.0 endpoint exposing this agent's tools via MCP
// same process, same tools registry, no separate server
app.post("/mcp", async (req, res) => {
  const { jsonrpc, id, method, params } = req.body;

  if (method === "initialize") {
    res.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "agent3", version: "1.0.0" },
        capabilities: { tools: {} },
      },
    });
    return;
  }

  if (method === "tools/list") {
    const toolList = Object.entries(tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          tool.params.map((p) => [p, { type: "string" }])
        ),
        required: tool.params,
      },
    }));
    res.json({ jsonrpc: "2.0", id, result: { tools: toolList } });
    return;
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params;
    if (!tools[name]) {
      res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `unknown tool: ${name}` },
      });
      return;
    }
    try {
      const result = await executeTool({ tool: name, params: args });
      res.json({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: result }] },
      });
    } catch (e: any) {
      res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: e.message },
      });
    }
    return;
  }

  res.json({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `unknown method: ${method}` },
  });
});

// handles an incoming Telegram update (from polling)
async function processTelegramUpdate(update: any) {
  const msg = await handleTelegramUpdate(update);
  if (!msg) return; // not a message update

  try {
    // forward to slack if message starts with slack-- (no response back to TG)
    if (msg.text.startsWith("slack--")) {
      const slackText = msg.text.slice(7); // remove "slack--" prefix
      await slackPostMessage({ channel: "boobs", text: `[TG] ${slackText}` }).catch(e => console.error("slack forward error:", e));
      return;
    }

    const result = await chat(msg.text, { includeProfile: false });
    logConversation(msg.text, result.response, "telegram");
    await telegramSend({ chat_id: msg.chatId, text: result.response });
  } catch (e: any) {
    console.error("telegram update error:", e);
    const errMsg = `error: ${e.message}`;
    logConversation(msg.text, errMsg, "telegram");
    await telegramSend({ chat_id: msg.chatId, text: errMsg }).catch(() => {});
  }
}

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`server running on http://localhost:${PORT}`);
  console.log(`  POST /chat    { "message": "..." }`);
  console.log(`  POST /ingest  { "text": "...", "source": "..." }`);
  console.log(`  POST /mcp     JSON-RPC 2.0 (initialize, tools/list, tools/call)`);
});

startTelegramPolling(processTelegramUpdate);
