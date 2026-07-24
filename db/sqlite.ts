import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import * as fs from "fs";
import { LOG_DB_PATH } from "../config";
import { IterationLog } from "../types";

let logDb: Database.Database | null = null;

function getLogDb(): Database.Database {
  if (logDb) return logDb;
  logDb = new Database(LOG_DB_PATH);

  logDb.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      timestamp TEXT,
      user_message TEXT,
      retrieved_chunks TEXT,   -- JSON array of chunks
      iterations TEXT,         -- JSON array of IterationLog
      final_response TEXT,
      total_iterations INTEGER,
      duration_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      request_id TEXT,
      timestamp TEXT,
      tool_name TEXT,
      params TEXT,
      result TEXT,
      duration_ms INTEGER,
      FOREIGN KEY (request_id) REFERENCES requests(id)
    );

    -- human feedback on a response
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      request_id TEXT,         -- which request this is feedback for
      timestamp TEXT,
      score INTEGER,           -- 1-10
      note TEXT,               -- free text, what was wrong
      corrected_response TEXT, -- what the response SHOULD have been
      feedback_type TEXT,      -- 'correction' | 'rating' | 'both'
      FOREIGN KEY (request_id) REFERENCES requests(id)
    );

    -- dpo training pairs derived from feedback
    -- export these for lora fine-tuning later
    CREATE TABLE IF NOT EXISTS training_pairs (
      id TEXT PRIMARY KEY,
      request_id TEXT,
      timestamp TEXT,
      prompt TEXT,             -- full prompt including context
      chosen TEXT,             -- the corrected/preferred response
      rejected TEXT,           -- what the agent actually said
      score_delta INTEGER,     -- how bad was the original (10 - score)
      exported INTEGER DEFAULT 0  -- flag: has this been used in training yet
    );
  `);

  return logDb;
}

export function logRequest(data: {
  id: string;
  userMessage: string;
  retrievedChunks: { text: string; source: string }[];
  iterations: IterationLog[];
  finalResponse: string;
  durationMs: number;
}) {
  const db = getLogDb();

  // sanitize iterations for JSON serialization (remove circular refs)
  const sanitizedIterations = data.iterations.map(iter => ({
    iteration: iter.iteration,
    llm_output: iter.llm_output,
    tool_called: iter.tool_called,
    tool_params: iter.tool_params,
    tool_result: iter.tool_result,
    duration_ms: iter.duration_ms,
    // skip llm_input to avoid serialization issues
  }));

  db.prepare(`
    INSERT INTO requests (id, timestamp, user_message, retrieved_chunks, iterations, final_response, total_iterations, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.id,
    new Date().toISOString(),
    data.userMessage,
    JSON.stringify(data.retrievedChunks),
    JSON.stringify(sanitizedIterations),
    data.finalResponse,
    data.iterations.length,
    data.durationMs,
  );

  for (const iter of data.iterations) {
    if (iter.tool_called) {
      db.prepare(`
        INSERT INTO tool_calls (id, request_id, timestamp, tool_name, params, result, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        data.id,
        new Date().toISOString(),
        iter.tool_called,
        JSON.stringify(iter.tool_params),
        iter.tool_result,
        iter.duration_ms,
      );
    }
  }
}

export function submitFeedback(
  requestId: string,
  score: number,
  note?: string,
  correctedResponse?: string,
) {
  const db = getLogDb();

  db.prepare(`
    INSERT INTO feedback (id, request_id, timestamp, score, note, corrected_response, feedback_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    requestId,
    new Date().toISOString(),
    score,
    note ?? null,
    correctedResponse ?? null,
    correctedResponse ? "correction" : "rating",
  );

  if (correctedResponse) {
    const request = db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as any;
    if (request) {
      const prompt = JSON.stringify({
        user_message: request.user_message,
        retrieved_chunks: JSON.parse(request.retrieved_chunks),
      });

      db.prepare(`
        INSERT INTO training_pairs (id, request_id, timestamp, prompt, chosen, rejected, score_delta, exported)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        randomUUID(),
        requestId,
        new Date().toISOString(),
        prompt,
        correctedResponse,
        request.final_response,
        10 - score,
      );
    }
  }
}

export function exportTrainingPairs(outputPath: string) {
  const db = getLogDb();
  const pairs = db.prepare("SELECT * FROM training_pairs WHERE exported = 0").all() as any[];

  const lines = pairs.map(p => JSON.stringify({
    prompt: JSON.parse(p.prompt),
    chosen: p.chosen,
    rejected: p.rejected,
  }));

  fs.writeFileSync(outputPath, lines.join("\n"));

  const ids = pairs.map(p => p.id);
  if (ids.length) {
    db.prepare(`UPDATE training_pairs SET exported = 1 WHERE id IN (${ids.map(() => "?").join(",")})`)
      .run(...ids);
  }

  console.log(`exported ${pairs.length} training pairs to ${outputPath}`);
  return pairs.length;
}
