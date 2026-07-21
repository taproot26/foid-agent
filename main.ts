import express from "express";
import { randomUUID } from "crypto";
import { LLM_URL, CHAT_MODEL, GROQ_API_KEY, MAX_TOOL_ITERATIONS } from "./config";
import { Message, IterationLog } from "./types";
import { retrieve, ingest } from "./rag";
import { buildToolPrompt, parseToolCall, executeTool } from "./tools";
import { logRequest } from "./db/sqlite";
import { profilePromptBlock } from "./profile";

async function llm(messages: Message[]): Promise<string> {
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 1000,
    }),
  });
  if (!res.ok) throw new Error(`LLM error: ${res.status} ${await res.text()}`);
  const data = await res.json() as any;
  return data.choices[0].message.content;
}

async function chat(userMessage: string): Promise<string> {
  const requestId = randomUUID();
  const requestStart = Date.now();
  const iterationLogs: IterationLog[] = [];

  const chunks = await retrieve(userMessage);
  const context = chunks
    .map((c, i) => `[${i + 1}] (source: ${c.source})\n${c.text}`)
    .join("\n\n---\n\n");

  const messages: Message[] = [
    { role: "system", content: buildToolPrompt() },
    { role: "system", content: profilePromptBlock() },
    { role: "system", content: `Relevant context from your knowledge base:\n${context}` },
    { role: "user", content: userMessage },
  ];

  let finalResponse = "max iterations reached";

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const iterStart = Date.now();
    const response = await llm(messages);
    const toolCall = parseToolCall(response);

    if (!toolCall) {
      iterationLogs.push({
        iteration: i,
        llm_input: messages,
        llm_output: response,
        tool_called: null,
        tool_params: null,
        tool_result: null,
        duration_ms: Date.now() - iterStart,
      });
      finalResponse = response;
      break;
    }

    const result = await executeTool(toolCall);

    iterationLogs.push({
      iteration: i,
      llm_input: [...messages],
      llm_output: response,
      tool_called: toolCall.tool,
      tool_params: toolCall.params,
      tool_result: result,
      duration_ms: Date.now() - iterStart,
    });

    messages.push({ role: "assistant", content: response });
    messages.push({ role: "user", content: `tool result: ${result}` });
  }

  logRequest({
    id: requestId,
    userMessage,
    retrievedChunks: chunks,
    iterations: iterationLogs,
    finalResponse,
    durationMs: Date.now() - requestStart,
  });

  console.log(`request ${requestId} done — ${iterationLogs.length} iteration(s), ${Date.now() - requestStart}ms`);
  return finalResponse;
}

// ---- server ----
const app = express();
app.use(express.json());

// POST /chat — { "message": "..." }
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    res.status(400).json({ error: "missing message" });
    return;
  }
  try {
    const response = await chat(message);
    res.json({ response });
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

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`server running on http://localhost:${PORT}`);
  console.log(`  POST /chat    { "message": "..." }`);
  console.log(`  POST /ingest  { "text": "...", "source": "..." }`);
});
