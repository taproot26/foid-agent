import Database from "better-sqlite3";
import { retrieve } from "../rag";
import { Tool, ToolCall } from "../types";
import { LOG_DB_PATH } from "../config";
import { webFetch } from './web_fetch';
import { webSearch } from './web_search';
import { lumaRegister } from './luma_register';
import { slackGetMessages, slackListChannels, slackPostMessage } from './slack_monitor';
import { telegramSend } from './telegram';
import { shellExec, nodeExec, rustExec, htmlPreview, writeCode, runAgentCode, readFile, findLine, editLines, checkFrontend } from './code';
import { writeCircom, compileCircom } from './circom';
import { ingestUrl, findSourceMaterial } from './ingest';
import {
  airbnbOpen, airbnbSearchDestination, airbnbOpenCalendar, airbnbSelectDates,
  airbnbClickSearch, airbnbScrapePage, airbnbNextPage, airbnbGetStats, airbnbClose,
} from './airbnb';
import { airbnbApiSearch, airbnbApiNextPage, airbnbApiGetStats, airbnbApiRecommend } from './airbnb_api_tools';

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

async function generateImage(params: Record<string, any>): Promise<string> {
  const prompt = params.prompt;
  if (!prompt) return "error: missing prompt";
  try {
    // Pollinations.ai — free, no auth, returns a direct image URL
    const encoded = encodeURIComponent(prompt);
    const url = `https://image.pollinations.ai/prompt/${encoded}`;

    // Download and save the image locally
    const fs = await import("fs").then(m => m.promises);
    const path = await import("path");
    const https = await import("https");

    const imageDir = path.resolve(__dirname, "../priv-docs/images");

    // Ensure directory exists
    try {
      await fs.mkdir(imageDir, { recursive: true });
    } catch {}

    // Generate a unique filename using timestamp + sanitized prompt
    const timestamp = Date.now();
    const sanitized = prompt.slice(0, 30).replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const filename = `${timestamp}_${sanitized}.png`;
    const filepath = path.join(imageDir, filename);

    // Download the image
    const response = await new Promise<Buffer>((resolve, reject) => {
      https.get(url, (res) => {
        let data = Buffer.alloc(0);
        res.on("data", (chunk) => {
          data = Buffer.concat([data, chunk]);
        });
        res.on("end", () => resolve(data));
        res.on("error", reject);
      }).on("error", reject);
    });

    // Save to file
    await fs.writeFile(filepath, response);

    return `Image generated and saved to: ${filepath}`;
  } catch (e: any) {
    return `error generating image: ${e.message}`;
  }
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
  slack_get_messages: {
    description: "fetch recent messages from a Slack channel by name (e.g. 'general', 'random')",
    params: ["channel", "limit"],
    run: slackGetMessages,
  },
  slack_list_channels: {
    description: "list all accessible Slack channels",
    params: [],
    run: slackListChannels,
  },
  slack_post_message: {
    description: "post a message to a Slack channel — only use when the user explicitly asks you to send something",
    params: ["channel", "text"],
    run: slackPostMessage,
  },
  telegram_send: {
    description: "send a message to a Telegram chat — only use when the user explicitly asks you to send something to Telegram",
    params: ["chat_id", "text"],
    run: telegramSend,
  },
  shell_exec: {
    description: "execute a shell command and return output — restricted to safe commands only",
    params: ["cmd"],
    run: shellExec,
  },
  node_exec: {
    description: "execute JavaScript code safely and return the result",
    params: ["code"],
    run: nodeExec,
  },
  rust_exec: {
    description: "compile and execute Rust code — must be complete program with fn main()",
    params: ["code"],
    run: rustExec,
  },
  html_preview: {
    description: "generate an HTML preview file with optional CSS and JavaScript — saves to .temp/preview.html",
    params: ["html", "css", "js"],
    run: htmlPreview,
  },
  write_code: {
    description: "write a code file into the agent-code directory — use this whenever the user asks you to write/create code. filename can include subfolders (e.g. 'utils/add.js')",
    params: ["filename", "code"],
    run: writeCode,
  },
  run_agent_code: {
    description: "run a shell command inside the agent-code directory (e.g. 'node add.js', 'python3 script.py') — restricted to that directory only",
    params: ["cmd"],
    run: runAgentCode,
  },
  write_circom: {
    description: "write a Circom circuit file (.circom) to the agent-code directory — use when the user asks you to write a zero-knowledge proof circuit",
    params: ["filename", "code"],
    run: writeCircom,
  },
  compile_circom: {
    description: "compile a Circom circuit file using the circom compiler — checks syntax and generates r1cs/wasm",
    params: ["filename"],
    run: compileCircom,
  },
  ingest_url: {
    description: "fetch content from a URL and add it to the knowledge base for future retrieval",
    params: ["url", "description"],
    run: ingestUrl,
  },
  find_source_material: {
    description: "search the web for useful documentation, tutorials, and examples on a topic, then automatically fetch and ingest the top results into the knowledge base",
    params: ["topic", "purpose"],
    run: findSourceMaterial,
  },
  read_file: {
    description: "read the contents of a file from the project (e.g. frontend/src/App.tsx) — use this to understand existing code before modifying it",
    params: ["filepath"],
    run: readFile,
  },
  find_line: {
    description: "find a line number by searching for a substring in a file. Example: find_line in 'frontend/src/App.tsx' for 'Test Button' returns the line number. Use this before edit_lines to locate what you want to change.",
    params: ["filepath", "query"],
    run: findLine,
  },
  edit_lines: {
    description: "replace lines X through Y in a file with new code. Use after find_line to identify the line range, then call this with the start and end line numbers and the replacement code. Does NOT require exact matching — just line numbers.",
    params: ["filepath", "start_line", "end_line", "new_code"],
    run: editLines,
  },
  check_frontend: {
    description: "type-check the frontend (runs `tsc -b`) to verify the code compiles with no TypeScript/JSX errors. Run this after editing any frontend file and before finishing, to make sure your change didn't break the build.",
    params: [],
    run: checkFrontend,
  },
  generate_image: {
    description: "generate an image from a text prompt using AI image generation. Returns a URL to the generated image. Use this when the user asks you to create, generate, or visualize something visual.",
    params: ["prompt"],
    run: generateImage,
  },
  airbnb_open: {
    description: "Step 1 of the Airbnb flow. Opens a browser and navigates to airbnb.com. Returns {ok, loaded}. Call this first, before any other airbnb_ tool.",
    params: [],
    run: airbnbOpen,
  },
  airbnb_search_destination: {
    description: "Step 2 of the Airbnb flow. Types the given city into the Where field and selects the first suggestion. Returns {ok, suggestionPicked, whereText}. Only call after airbnb_open succeeded (ok:true). If ok:false, do not proceed -- retry this step or report the failure.",
    params: ["city"],
    run: airbnbSearchDestination,
  },
  airbnb_open_calendar: {
    description: "Step 3 of the Airbnb flow. Clicks 'Add dates' and waits for the calendar to render. Returns {ok, calendarOpen}. Only call after airbnb_search_destination succeeded. If ok:false, the calendar never opened -- do not proceed to date selection.",
    params: [],
    run: airbnbOpenCalendar,
  },
  airbnb_select_dates: {
    description: "Step 4 of the Airbnb flow. Selects check-in and check-out days within the specified month. monthName must be exactly 'MonthName YYYY' (e.g. 'September 2026') -- this tool verifies via each day button's own aria-label that the click landed in the correct month/year, not just the right day number, so it will not silently pick the wrong month. Returns {ok, whenText, stillPlaceholder}. Only call after airbnb_open_calendar succeeded. If ok:false, dates were not confirmed -- do not click search.",
    params: ["checkInDay", "checkOutDay", "monthName"],
    run: airbnbSelectDates,
  },
  airbnb_click_search: {
    description: "Step 5 of the Airbnb flow. Clicks the Search button and waits for the results page to load. Returns {ok, url}. Only call after airbnb_select_dates succeeded (ok:true, stillPlaceholder:false).",
    params: [],
    run: airbnbClickSearch,
  },
  airbnb_scrape_page: {
    description: "Step 6 of the Airbnb flow. Scrolls the CURRENT results page (using page-level scroll, never the mouse over the embedded map) and scrapes all listing cards: name, price, rating. Returns {ok, listingCount, sampleListings}. Call once per page -- call again after airbnb_next_page to scrape the next page.",
    params: [],
    run: airbnbScrapePage,
  },
  airbnb_next_page: {
    description: "Step 7 of the Airbnb flow (optional). Clicks the numbered pagination link/button for targetPageNumber (Airbnb renders page numbers as 1, 2, 3, ... not a 'Next' label -- pass the literal next page number, e.g. 2). Returns {ok, hasNext}. If ok:false there is no next page -- stop paginating and finish with what you've scraped.",
    params: ["targetPageNumber"],
    run: airbnbNextPage,
  },
  airbnb_get_stats: {
    description: "Computes average/median price and rating across every listing scraped so far via airbnb_scrape_page (across all pages). Call this once at the end instead of computing stats yourself -- it has the full dataset, you only see samples. Returns {ok, totalListings, averagePrice, medianPrice, averageRating, medianRating}.",
    params: [],
    run: airbnbGetStats,
  },
  airbnb_close: {
    description: "Closes the Airbnb browser session. Call this once you are done scraping and have reported results to the user.",
    params: [],
    run: airbnbClose,
  },
  airbnb_api_search: {
    description: "Direct-fetch Airbnb search -- no browser, no calendar UI. city, checkin, checkout (YYYY-MM-DD dates) are required. minBedrooms/minBathrooms/maxBathrooms are OPTIONAL integers -- only pass them if the user actually asked for a bedroom/bathroom filter, otherwise omit entirely. Prices are always fetched in USD. Returns {ok, searchUrl, pageListingCount, totalListingCountSoFar, hasNextPage}. Call this first for the API method, instead of airbnb_open.",
    params: ["city", "checkin", "checkout"],
    optionalParams: ["minBedrooms", "minBathrooms", "maxBathrooms"],
    run: airbnbApiSearch,
  },
  airbnb_api_next_page: {
    description: "Fetches the next page of results for the search started by airbnb_api_search, using its cursor. Returns {ok, pageListingCount, totalListingCountSoFar, hasNextPage}. If ok:false or hasNextPage:false, there is no next page -- stop paginating.",
    params: [],
    run: airbnbApiNextPage,
  },
  airbnb_api_get_stats: {
    description: "Computes average/median price (both total-stay and per-night, in USD) and rating across every listing fetched so far via airbnb_api_search/airbnb_api_next_page. Call this once at the end instead of computing stats yourself. Returns {ok, totalListings, currency, nights, averageTotalPrice, medianTotalPrice, averagePricePerNight, medianPricePerNight, averageRating, medianRating}.",
    params: [],
    run: airbnbApiGetStats,
  },
  airbnb_api_recommend: {
    description: "Scores and ranks every listing fetched so far (up to 50) against the group's own median/average price-per-night and rating. A listing scores +1 for above-median rating, +1 for below-median price; PLUS an extra +2 if it clears BOTH the average rating and average price bar (a stronger 'good deal' signal). Returns the top 10 sorted by score, each tagged with which bars it cleared. Use this INSTEAD of airbnb_api_get_stats when the user wants a recommendation, not just raw stats. Returns {ok, poolSize, medianPricePerNight, averagePricePerNight, medianRating, averageRating, recommendedCount, topRecommendations}.",
    params: [],
    run: airbnbApiRecommend,
  },
};

// ---- Agent routing & modes ----
export type Mode = "plan" | "act";
export type AgentType = "coding" | "general" | "airbnb";

// First-message router: decide which agent to use. Coding-specific keywords → coding agent,
// airbnb-specific keywords → airbnb agent, else → general.
const CODING_KEYWORDS = [
  "frontend", "app.tsx", "button", "edit_lines", "find_line", "read_file",
  "line", "file", "component", "jsx", "tsx", "code", "compile", "check_frontend",
  "bug", "fix", "css", "style", "function", "typescript",
];

const AIRBNB_KEYWORDS = ["airbnb", "listing", "listings", "vacation rental"];

export function routeAgent(userMessage: string): AgentType {
  const lower = userMessage.toLowerCase();
  if (AIRBNB_KEYWORDS.some(k => lower.includes(k))) return "airbnb";
  return CODING_KEYWORDS.some(k => lower.includes(k)) ? "coding" : "general";
}

// ---- Cline-style Plan/Act mode (faithful port, adapted to this harness's tool names) ----
// Plan mode = read-only exploration + present a plan, then STOP and wait for approval.
// Act mode  = full execution. The switch is an explicit switch_to_act_mode tool call, gated
// on the user approving in a follow-up message (never in the same turn the plan is presented).

// Coding agent: small focused menu (Plan/Act split)
const CODING_PLAN_TOOLS = ["read_file", "find_line", "check_frontend"];                                    // read-only inspection
const CODING_ACT_TOOLS = ["read_file", "find_line", "edit_lines", "check_frontend", "write_code", "run_agent_code"];

// General agent: wide menu, no Plan/Act split (routing happens at session creation, not per-message)
const GENERAL_TOOLS = [
  "search_knowledge", "calculator", "get_current_date", "get_recent_history",
  "web_search", "web_fetch", "generate_image",
  "luma_register", "slack_get_messages", "slack_list_channels", "slack_post_message",
  "telegram_send", "shell_exec", "node_exec", "write_code", "run_agent_code",
];

// Airbnb agent: scoped to ONLY the airbnb_* tools. Keeping these out of the general
// agent's menu matters for a small local model -- with 20+ unrelated tools (slack,
// telegram, calculator, ...) competing for attention it has skipped straight from
// picking a destination to scraping the homepage, never touching the calendar/date
// tools at all. A narrow, single-purpose menu removes that distraction entirely.
const AIRBNB_TOOLS = [
  "airbnb_open", "airbnb_search_destination", "airbnb_open_calendar", "airbnb_select_dates",
  "airbnb_click_search", "airbnb_scrape_page", "airbnb_next_page", "airbnb_get_stats", "airbnb_close",
  "airbnb_api_search", "airbnb_api_next_page", "airbnb_api_get_stats", "airbnb_api_recommend",
];

export const SWITCH_TO_ACT_MODE = "switch_to_act_mode";

// Cline's switch_to_act_mode tool: empty schema, only offered in plan mode. Calling it ends the
// plan turn; our loop then flips the session to act mode and auto-continues (see main.ts).
const SWITCH_TO_ACT_MODE_SCHEMA = {
  type: "function",
  function: {
    name: SWITCH_TO_ACT_MODE,
    description:
      "Switch from plan mode to act mode. Switching to act mode immediately starts executing the plan, so only call this after the user has explicitly approved the plan in a message sent AFTER you presented it (e.g. 'looks good', 'go ahead', 'switch to act mode'). Never call this in the same turn you present a plan, never call it proactively, and never treat the original task request as approval.",
    parameters: { type: "object", properties: {}, required: [] as string[] },
  },
};

// Synthetic user message that drives the auto-continue turn after switch_to_act_mode (Cline's ACT_MODE_CONTINUATION_PROMPT).
export const ACT_MODE_CONTINUATION_PROMPT =
  "The user approved switching to act mode. Continue with the approved plan now.";

// Explains the <user_input mode="..."> wrapper we stamp on coding messages (Cline's MODE_TAG_INSTRUCTIONS).
const MODE_TAG_INSTRUCTIONS = `# Plan / Act Modes

User messages arrive wrapped in a <user_input mode="..."> tag. The mode attribute is the interaction mode when the message was sent: "plan" means plan-mode constraints applied (explore, analyze, and align on a plan -- no edits), while "act" means implementation was allowed. If the mode attribute changes between messages, the user switched modes -- the newest message's mode governs now, regardless of what earlier messages allowed.`;

// Plan-mode behavioral contract (Cline's PLAN_MODE_INSTRUCTIONS), adapted to our tools.
const PLAN_MODE_INSTRUCTIONS = `# Plan Mode

You are in Plan mode. Your role is to explore, analyze, and plan -- not to execute.

- Read files (read_file) and locate code (find_line) to understand the problem
- Ask clarifying questions when requirements are ambiguous
- Present your plan as a structured, numbered outline with clear steps
- Explain tradeoffs between different approaches when they exist
- Do NOT edit files or make any changes -- you do not have edit_lines or write_code in this mode

check_frontend remains available in plan mode strictly for read-only inspection of the current build state. Never use plan mode to change anything -- if the task requires an edit, put it in the plan; it happens only after the user switches to act mode.

Once the user has reviewed your plan and explicitly approved it in a follow-up message, use the switch_to_act_mode tool to switch to act mode and begin implementation. Calling switch_to_act_mode immediately starts execution, so never call it in the same turn you present a plan and never treat the original task request as approval -- end your turn after presenting the plan and wait for the user's response.`;

// system prompt is now just behavioral instructions — the tool schemas themselves are sent to
// Ollama's native `tools` API (see getToolSchemas), which constrains the model's output at the
// token level so it can't hallucinate a tool name or malform its arguments.
export function buildToolPrompt(agent: AgentType, mode: Mode = "act"): string {
  if (agent === "coding") {
    const base = `You are a coding assistant that edits an existing codebase using tools.

PLANNING: Always show your planning process before executing. Begin by analyzing the request, then present a short numbered plan of the steps and tool calls you intend to make. It is fine for this to be brief.

TOOL USE: You keep working by calling tools. Emit tool calls in every response until the task is fully complete. A response with NO tool calls is treated as your final answer — only do that once the task is done and verified.

CRITICAL — ACT, DON'T NARRATE: Be proactive. Don't ask permission to do something when you can just do it. NEVER say you "will" do something, describe a "next step", or write "let's proceed" without ALSO emitting the actual tool call for it in the SAME response. If you state you are about to edit a file, the edit_lines tool call MUST be in that same response. Stating an intention without the matching tool call ends the task with the work unfinished — do not do this.

BATCHING: When you need several INDEPENDENT pieces of information (e.g. reading two different files, or two separate searches), request them all in a single response instead of one per turn. Do NOT batch operations that depend on each other's output.

CRITICAL for edits — these steps are DEPENDENT and must happen in ORDER, across SEPARATE responses. Never guess line numbers:
1. read_file — get the current contents with line numbers shown as "linenum|content". Look at the ACTUAL numbers before doing anything else.
2. find_line — confirm the exact line number where the change goes (only after you have read the file).
3. edit_lines — replace lines [start_line, end_line] (inclusive, 1-indexed) with new code. Use ONLY line numbers you have seen in the read_file / find_line output above — never numbers you assumed.
4. check_frontend — ALWAYS run this after any edit. If it reports errors you are NOT done: read_file again to see the current state, locate the problem, edit_lines to fix it, and check_frontend again. Repeat until it passes with zero errors.
5. Only give a plain-text final answer (no tool calls) AFTER check_frontend passes clean. Never claim completion while check_frontend still reports errors.`;

    // mode semantics ride in a rules block appended to the base prompt, mirroring Cline's
    // buildClineSystemPrompt (base prompt, then mode-tag explanation, then plan contract if in plan mode).
    const parts = [base, MODE_TAG_INSTRUCTIONS];
    if (mode === "plan") parts.push(PLAN_MODE_INSTRUCTIONS);
    return parts.join("\n\n");
  }

  if (agent === "airbnb") {
    return `You are an Airbnb search assistant. You ONLY have airbnb_* tools -- use them, one tool call per response, checking the previous result before calling the next. ALWAYS write your final answer to the user in ENGLISH, regardless of the destination or city name.

TWO METHODS -- pick ONE per task, never mix tools from both in the same run:
- API method (airbnb_api_search / airbnb_api_next_page / airbnb_api_get_stats): direct fetch, no browser, no calendar UI. Faster, and there is no "wrong month" or "map click" failure mode because there is no UI. Use this by default for a plain "get me listings/stats for X" request.
- Browser method (airbnb_open ... airbnb_close, 9 steps below): drives a real browser through airbnb.com's UI. Only use this if the user specifically asks to see it happen in a browser, or the API method fails.

=== API METHOD (default, 4 tools) ===
1. airbnb_api_search({city, checkin, checkout, [minBedrooms], [minBathrooms], [maxBathrooms]}) -- checkin/checkout MUST be "YYYY-MM-DD" (e.g. "2026-09-03"). Only include minBedrooms/minBathrooms/maxBathrooms if the user actually asked for that filter -- omit them entirely otherwise, do not invent a value. Prices always come back in USD. Returns {ok, searchUrl, pageListingCount, totalListingCountSoFar, hasNextPage}.
2. airbnb_api_next_page() -- optional, only if the user wants more than one page or a bigger pool (e.g. "top 50 listings" needs ~3 calls: 1 search + 2 next_page, since each page is ~18). Repeat while hasNextPage is true and you still need more. There's a hard cap of 50 listings total -- hasNextPage flips to false automatically once reached, even if Airbnb has more.
3. airbnb_api_get_stats() -- call for plain stats requests (just average/median price and rating, no recommendation). Returns BOTH averageTotalPrice/medianTotalPrice (the full stay cost) AND averagePricePerNight/medianPricePerNight (divided by the number of nights) -- Airbnb's own price label is always the total for the whole stay, never a nightly rate, so report whichever the user actually asked for (default to per-night if unspecified). Do NOT compute these yourself.
4. airbnb_api_recommend() -- call INSTEAD of airbnb_api_get_stats when the user wants recommendations/picks, not just numbers. Scores every fetched listing against the group's own median/average (above-median rating +1, below-median price +1, PLUS +2 extra if it beats BOTH the average rating and average price). Returns the top 10 by score, each with title/subtitle/url/price/rating. Do NOT compute this scoring yourself.

DATE RANGES -- "the month of October" (or any bare month name with no day given) means checkin = the 1st of that month, checkout = the LAST day of that month (30 or 31, whichever that month actually has -- don't guess, use the real calendar length). If the user gives explicit day numbers ("Sept 3 to 10"), use those instead.

WORKED EXAMPLE (API method, two pages, with bedroom + bathroom filter):
User: "Search Airbnb for Phuket, October 1 to 8, minimum 1 bedroom and exactly 1 bathroom. Show 2 pages, give me per-night price in USD."
Call 1: airbnb_api_search({"city":"Phuket","checkin":"2026-10-01","checkout":"2026-10-08","minBedrooms":"1","minBathrooms":"1","maxBathrooms":"1"}) -> {"ok":true,"searchUrl":"https://www.airbnb.com/s/Phuket/homes?...&currency=USD&min_bedrooms=1&min_bathrooms=1&max_bathrooms=1","pageListingCount":18,"totalListingCountSoFar":18,"hasNextPage":true}
Call 2: airbnb_api_next_page() -> {"ok":true,"pageListingCount":18,"totalListingCountSoFar":36,"hasNextPage":true}
Call 3: airbnb_api_get_stats() -> {"ok":true,"totalListings":36,"currency":"USD","nights":7,"averageTotalPrice":2211,"medianTotalPrice":1358,"averagePricePerNight":316,"medianPricePerNight":194,"averageRating":4.94,"medianRating":4.97}
Final answer (no tool call): "I fetched Phuket for Oct 1-8 (7 nights), minimum 1 bedroom / exactly 1 bathroom, across 2 pages (36 listings). Average price: $316/night (median $194/night). Average rating: 4.94 (median 4.97)."

WORKED EXAMPLE (API method, recommendation over top 50):
User: "Pull the top 50 listings for Phuket, October 1 to 8, and recommend ones that are above median rating and below median price -- give extra weight to ones also above average rating and below average price."
Call 1: airbnb_api_search({"city":"Phuket","checkin":"2026-10-01","checkout":"2026-10-08"}) -> {"ok":true,"pageListingCount":18,"totalListingCountSoFar":18,"hasNextPage":true}
Call 2: airbnb_api_next_page() -> {"ok":true,"pageListingCount":18,"totalListingCountSoFar":36,"hasNextPage":true}
Call 3: airbnb_api_next_page() -> {"ok":true,"pageListingCount":14,"totalListingCountSoFar":50,"hasNextPage":false}
Call 4: airbnb_api_recommend() -> {"ok":true,"poolSize":50,"medianPricePerNight":58,"averagePricePerNight":74,"medianRating":4.9,"averageRating":4.87,"recommendedCount":19,"topRecommendations":[{"title":"Apartment in Kathu","subtitle":"Cozy 1BR near beach","pricePerNight":42,"rating":4.97,"score":4,...}, ...]}
Final answer (no tool call): "Pulled the top 50 listings for Phuket Oct 1-8. Median: $58/night, 4.9 rating. Average: $74/night, 4.87 rating. 19 of 50 beat the median on both price and rating -- here are the top picks: 1. Apartment in Kathu (Cozy 1BR near beach) -- $42/night, 4.97 rating [clears both average bars too]. 2. ... [list a few more]."

=== BROWSER METHOD (fallback, 9 tools) ===
MUST happen in this exact order:
1. airbnb_open — always first.
2. airbnb_search_destination(city) — only after step 1 returned ok:true.
3. airbnb_open_calendar — only after step 2 returned ok:true.
4. airbnb_select_dates(checkInDay, checkOutDay, monthName) — only after step 3 returned ok:true. monthName MUST be the exact string "MonthName YYYY" (e.g. "September 2026") matching what the user asked for. This tool verifies via the actual day button's aria-label that you landed in the right month/year -- trust its returned ok/whenText over your own guess.
5. airbnb_click_search — only after step 4 returned ok:true (whenText shows real dates, not a placeholder). The tool itself will refuse (ok:false) if dates were never confirmed, so you cannot skip step 4.
6. airbnb_scrape_page — call after step 5 succeeds, and again after every airbnb_next_page call. The tool itself will refuse (ok:false) if search was never clicked, so you cannot skip to scraping the homepage.
7. airbnb_next_page(targetPageNumber) — optional, only if the user wants more than one page. Pass the literal next page number (2, then 3, ...). If ok:false, there is no next page -- stop paginating.
8. airbnb_get_stats — call once at the end for average/median price and rating across everything scraped. Do NOT compute these yourself from sample listings -- you only see a few samples per page, this tool has the full dataset.
9. airbnb_close — call once you've reported results to the user.

If a step returns ok:false, do NOT proceed. Retry that exact same tool call once; if it fails again, stop and tell the user which step failed and why, using the returned error/state.

MONTH/YEAR: pass monthName as "MonthName YYYY" (e.g. "October 2026"). If you are unsure of the year, still pass a year — the tool ignores a wrong year and navigates to the soonest future occurrence of that month name automatically, so "October 2023" and "October 2026" both land on the correct upcoming October. Never worry about which year the calendar is showing; the tool reads the visible months itself.

WORKED EXAMPLE (two pages) — this is the exact shape of a real successful run, follow it:
User: "Search Airbnb for Bangkok, September 3 to 10, scrape the first two pages, and give me the average and median price and rating."
Call 1: airbnb_open() -> {"ok":true,"loaded":true}
Call 2: airbnb_search_destination({"city":"Bangkok"}) -> {"ok":true,"confirmedDestination":"Bangkok"}
Call 3: airbnb_open_calendar() -> {"ok":true,"calendarOpen":true}
Call 4: airbnb_select_dates({"checkInDay":"3","checkOutDay":"10","monthName":"September 2026"}) -> {"ok":true,"confirmedDates":"Sep 3 - 10","stillPlaceholder":false}
Call 5: airbnb_click_search() -> {"ok":true,"url":"https://www.airbnb.com/s/Bangkok--Thailand/homes?..."}
Call 6: airbnb_scrape_page() -> {"ok":true,"pageListingCount":24,"totalListingCountSoFar":24}
Call 7: airbnb_next_page({"targetPageNumber":"2"}) -> {"ok":true,"hasNext":true}
Call 8: airbnb_scrape_page() -> {"ok":true,"pageListingCount":18,"totalListingCountSoFar":42}
Call 9: airbnb_get_stats() -> {"ok":true,"totalListings":42,"averagePrice":57764,"medianPrice":57778,"averageRating":4.92,"medianRating":4.96}
Call 10: airbnb_close() -> {"ok":true,"closed":true}
Final answer (no tool call): "I searched Bangkok for Sep 3-10 across 2 pages (42 listings). Average price: ¥57,764 (median ¥57,778). Average rating: 4.92 (median 4.96)."`;
  }

  return `You are a helpful assistant with access to tools.

Rules for tool use:
- ALWAYS use web_search for any question about current events, news, recent information, upcoming events, or anything that may have changed after your training cutoff.
- ALWAYS use web_search if you are not fully certain of the answer.
- ALWAYS use get_recent_history if the user asks what they previously said or asked.
- ALWAYS use web_fetch if the user asks you to fetch or read a specific URL.
- Use write_code only for code that you want to write to the agent-code sandbox directory.
- Use run_agent_code if the user asks you to run/execute code you just wrote to agent-code.
- Do NOT answer from memory if a tool is available that could give a better answer.`;
}

// generates Ollama/OpenAI-style function-calling schemas from the tool registry.
// every param is typed as a string — our tool run()s all parseInt/parse what they need themselves.
// coding agent gets a mode-restricted menu: plan mode = read-only + switch_to_act_mode, act mode = full.
// general agent always gets the full general tool set (no Plan/Act split).
export function getToolSchemas(agent: AgentType, mode: Mode = "act") {
  let names: string[];
  if (agent === "coding") {
    names = mode === "plan" ? CODING_PLAN_TOOLS : CODING_ACT_TOOLS;
  } else if (agent === "airbnb") {
    names = AIRBNB_TOOLS;
  } else {
    names = GENERAL_TOOLS;
  }

  const schemas = names.map(name => {
    const allParams = [...tools[name].params, ...(tools[name].optionalParams ?? [])];
    return {
      type: "function",
      function: {
        name,
        description: tools[name].description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(allParams.map(p => [p, { type: "string" }])),
          required: tools[name].params,
        },
      },
    };
  });

  // plan mode is the only place switch_to_act_mode exists — it's the gate out of plan mode (coding agent only).
  if (agent === "coding" && mode === "plan") schemas.push(SWITCH_TO_ACT_MODE_SCHEMA);
  return schemas;
}

// Playwright/browser steps (and anything else) can wedge with no error and no
// timeout of their own -- Ollama then waits forever for a tool result that
// never comes. Race every tool call against a hard deadline so a stuck step
// surfaces as a normal {ok:false} result the LLM can react to, instead of a
// silently hung request.
const TOOL_TIMEOUT_MS = 20_000;

export async function executeTool(call: ToolCall): Promise<string> {
  const tool = tools[call.tool];
  if (!tool) return `unknown tool: ${call.tool}`;
  try {
    return await Promise.race([
      tool.run(call.params),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(`tool "${call.tool}" timed out after ${TOOL_TIMEOUT_MS / 1000}s -- it may still be running in the background, but this call is being reported as failed`)), TOOL_TIMEOUT_MS)
      ),
    ]);
  } catch (e: any) {
    return `tool error: ${e.message}`;
  }
}
