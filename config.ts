import fs from "fs";
import path from "path";

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([^=#\s]+)=(.*)$/);
    if (match) process.env[match[1]] = match[2].trim();
  }
}

export const GROQ_API_KEY = ""; // forced local — testing native Ollama tool-calling
export const LLM_URL = "http://localhost:11434/api/chat";
export const CHAT_MODEL = "qwen2.5:14b";
export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const DB_PATH = "./rag-vec.db";
export const LOG_DB_PATH = "./logs.db";
export const TABLE_NAME = "knowledge";
export const TOP_K = 3;
export const CANDIDATE_POOL = 10;
export const MAX_DISTANCE = 1.0; // L2 distance on normalized vectors; ~0 identical, ~2 opposite
export const RRF_K = 60;
export const CHUNK_SIZE = 512;
export const CHUNK_OVERLAP = 50;
export const VECTOR_DIM = 384;
export const MAX_TOOL_ITERATIONS = 15; // Cline-style: keep looping until the model stops emitting tool calls
export const PROFILE_PATH = "./profile.data.json";
