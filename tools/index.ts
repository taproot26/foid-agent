import Database from "better-sqlite3";
import { retrieve } from "../rag";
import { Tool, ToolCall } from "../types";
import { LOG_DB_PATH } from "../config";
import { webFetch } from './web_fetch';
import { webSearch } from './web_search';
import { lumaRegister } from './luma_register';

async function searchKnowledge(params: Record<string, any>): Promise<string> {
  const chunks = await retrieve(params.query);
  if (!chunks.length) return "no relevant information found";
  return chunks.map((c, i) => `[${i + 1}] ${c.text}`).join("\n\n");
}

async function calculator(params: Record<string, any>): Promise<string> {
  const expr: string = params.expr;
  if (!/^[\d\s\+\-\*\/\.\(\)]+$/.test(expr)) return "invalid expression";
  return String(eval(expr));
}

async function getCurrentDate(_params: Record<string, any>): Promise<string> {
  return new Date().toISOString();
}

async function getRecentHistory(params: Record<string, any>): Promise<string> {
  const limit = Math.min(parseInt(params.limit) || 5, 20);
  const db = new Database(LOG_DB_PATH);
  const rows = db.prepare(
    `SELECT timestamp, user_message, final_response FROM requests
     WHERE user_message NOT LIKE '%what did%'
       AND user_message NOT LIKE '%what was%'
       AND user_message NOT LIKE '%recent%'
       AND user_message NOT LIKE '%last question%'
     ORDER BY timestamp DESC LIMIT ?`
  ).all(limit) as any[];
  if (!rows.length) return "no conversation history found";
  return rows.map((r, i) =>
    `[${i === 0 ? "MOST RECENT" : `older-${i}`}]\nTimestamp: ${r.timestamp}\nYou asked: "${r.user_message}"\nI answered: "${r.final_response}"`
  ).join("\n\n---\n\n");
}

export const tools: Record<string, Tool> = {
  search_knowledge: {
    description: "search the knowledge base for relevant information",
    params: ["query"],
    run: searchKnowledge,
  },
  calculator: {
    description: "evaluate a basic math expression",
    params: ["expr"],
    run: calculator,
  },
  get_current_date: {
    description: "get the current date and time",
    params: [],
    run: getCurrentDate,
  },
  get_recent_history: {
    description: "retrieve recent conversation history from the database — use when asked about previous questions or answers",
    params: ["limit"],
    run: getRecentHistory,
  },
  web_fetch: {
    description: "fetch the content of a URL and return readable text",
    params: ["url"],
    run: webFetch,
  },
  web_search: {
    description: "search the web using DuckDuckGo and return relevant results",
    params: ["query"],
    run: webSearch,
  },
  luma_register: {
    description: "register/RSVP for a Luma event given its URL — uses the user's saved profile for name/email — only use when the user explicitly confirms they want to register",
    params: ["url"],
    run: lumaRegister,
  },
};

export function buildToolPrompt(): string {
  const toolList = Object.entries(tools)
    .map(([name, t]) => `- ${name}(${t.params.join(", ")}): ${t.description}`)
    .join("\n");

  return `You are a helpful assistant with access to the following tools:

${toolList}

To use a tool, respond with ONLY a JSON object like this:
{ "tool": "tool_name", "params": { "param1": "value1" } }

When you have enough information to answer, respond normally in plain text.
Never mix JSON and plain text in the same response.

Rules for tool use:
- ALWAYS use web_search for any question about current events, news, recent information, upcoming events, or anything that may have changed after your training cutoff.
- ALWAYS use web_search if you are not fully certain of the answer.
- ALWAYS use get_recent_history if the user asks what they previously said or asked.
- ALWAYS use web_fetch if the user asks you to fetch or read a specific URL.
- Do NOT answer from memory if a tool is available that could give a better answer.`;
}

export function parseToolCall(response: string): ToolCall | null {
  const match = response.match(/\{[\s\S]*"tool"[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed.tool && parsed.params !== undefined) return parsed;
    return null;
  } catch {
    return null;
  }
}

export async function executeTool(call: ToolCall): Promise<string> {
  const tool = tools[call.tool];
  if (!tool) return `unknown tool: ${call.tool}`;
  try {
    return await tool.run(call.params);
  } catch (e: any) {
    return `tool error: ${e.message}`;
  }
}
