import fs from "fs";
import path from "path";

const PRIV_DOCS_DIR = path.join(__dirname, "..", "priv-docs");
const CONVERSATIONS_FILE = path.join(PRIV_DOCS_DIR, "conversations.md");

export function ensurePrivDocsDir() {
  if (!fs.existsSync(PRIV_DOCS_DIR)) {
    fs.mkdirSync(PRIV_DOCS_DIR, { recursive: true });
  }
}

export function logConversation(userMessage: string, agentResponse: string, source: string = "api") {
  ensurePrivDocsDir();

  const timestamp = new Date().toISOString();
  const entry = `
## ${timestamp} (${source})
**User:** ${userMessage}
**Agent:** ${agentResponse}
`;

  fs.appendFileSync(CONVERSATIONS_FILE, entry + "\n");
}

export function getConversationHistory(): string {
  ensurePrivDocsDir();
  if (fs.existsSync(CONVERSATIONS_FILE)) {
    return fs.readFileSync(CONVERSATIONS_FILE, "utf-8");
  }
  return "No conversation history yet.";
}
