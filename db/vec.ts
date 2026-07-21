import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { DB_PATH, TABLE_NAME, VECTOR_DIM, TOP_K, CANDIDATE_POOL, MAX_DISTANCE, RRF_K } from "../config";

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  db = new Database(DB_PATH);
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id TEXT PRIMARY KEY,
      text TEXT,
      source TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE_NAME}_vec
      USING vec0(vector float[${VECTOR_DIM}]);
    CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE_NAME}_fts
      USING fts5(id UNINDEXED, text);
  `);
  return db;
}

export function insertRows(rows: { id: string; text: string; source: string; vector: number[] }[]) {
  const db = getDb();
  const insertMeta = db.prepare(`INSERT OR REPLACE INTO ${TABLE_NAME} (id, text, source) VALUES (?, ?, ?)`);
  const insertVec  = db.prepare(`INSERT OR REPLACE INTO ${TABLE_NAME}_vec (rowid, vector) VALUES ((SELECT rowid FROM ${TABLE_NAME} WHERE id = ?), ?)`);
  const deleteFts  = db.prepare(`DELETE FROM ${TABLE_NAME}_fts WHERE id = ?`);
  const insertFts  = db.prepare(`INSERT INTO ${TABLE_NAME}_fts (id, text) VALUES (?, ?)`);

  const tx = db.transaction(() => {
    for (const row of rows) {
      insertMeta.run(row.id, row.text, row.source);
      insertVec.run(row.id, Buffer.from(new Float32Array(row.vector).buffer));
      deleteFts.run(row.id);
      insertFts.run(row.id, row.text);
    }
  });
  tx();
}

interface Candidate {
  id: string;
  text: string;
  source: string;
}

function vectorSearch(queryVec: number[], limit: number): Candidate[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT k.id, k.text, k.source, kv.distance AS distance
    FROM ${TABLE_NAME}_vec kv
    JOIN ${TABLE_NAME} k ON k.rowid = kv.rowid
    WHERE kv.vector MATCH ? AND kv.k = ?
    ORDER BY kv.distance
  `).all(Buffer.from(new Float32Array(queryVec).buffer), limit) as (Candidate & { distance: number })[];

  return rows.filter(r => r.distance <= MAX_DISTANCE);
}

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "do", "does", "did",
  "of", "to", "in", "on", "at", "for", "and", "or", "but", "with", "how", "what",
  "where", "when", "which", "who", "why", "i", "you", "we", "they", "my", "your",
  "this", "that", "these", "those", "get", "many", "much", "can", "could", "would",
]);

function keywordSearch(queryText: string, limit: number): Candidate[] {
  const db = getDb();
  const terms = queryText
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !STOPWORDS.has(t.toLowerCase()))
    .map(t => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ");
  if (!terms) return [];

  try {
    return db.prepare(`
      SELECT k.id, k.text, k.source
      FROM ${TABLE_NAME}_fts
      JOIN ${TABLE_NAME} k ON k.id = ${TABLE_NAME}_fts.id
      WHERE ${TABLE_NAME}_fts MATCH ?
      ORDER BY bm25(${TABLE_NAME}_fts)
      LIMIT ?
    `).all(terms, limit) as Candidate[];
  } catch {
    // malformed FTS query (e.g. reserved characters) — skip keyword leg, vector search still applies
    return [];
  }
}

export function hybridSearch(queryVec: number[], queryText: string, limit: number = TOP_K): { text: string; source: string }[] {
  const vecResults = vectorSearch(queryVec, CANDIDATE_POOL);
  const kwResults = keywordSearch(queryText, CANDIDATE_POOL);

  const scores = new Map<string, number>();
  const byId = new Map<string, Candidate>();

  for (const list of [vecResults, kwResults]) {
    list.forEach((row, rank) => {
      scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (RRF_K + rank + 1));
      byId.set(row.id, row);
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => byId.get(id)!)
    .map(({ text, source }) => ({ text, source }));
}

export function resetTable() {
  const db = getDb();
  db.exec(`
    DROP TABLE IF EXISTS ${TABLE_NAME};
    DROP TABLE IF EXISTS ${TABLE_NAME}_vec;
    DROP TABLE IF EXISTS ${TABLE_NAME}_fts;
  `);
  db.exec(`
    CREATE TABLE ${TABLE_NAME} (id TEXT PRIMARY KEY, text TEXT, source TEXT);
    CREATE VIRTUAL TABLE ${TABLE_NAME}_vec USING vec0(vector float[${VECTOR_DIM}]);
    CREATE VIRTUAL TABLE ${TABLE_NAME}_fts USING fts5(id UNINDEXED, text);
  `);
}
