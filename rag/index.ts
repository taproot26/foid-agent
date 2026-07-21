import { pipeline } from "@huggingface/transformers";
import { EMBED_MODEL, CHUNK_SIZE, CHUNK_OVERLAP } from "../config";
import { insertRows, hybridSearch } from "../db/vec";
import { Row } from "../types";

let embedder: any = null;

export async function embed(text: string): Promise<number[]> {
  if (!embedder) {
    console.log("loading embedding model...");
    embedder = await pipeline("feature-extraction", EMBED_MODEL);
  }
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(output.data) as number[];
}

export function chunk(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if ((current + para).length > size) {
      if (current) chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }
  if (current) chunks.push(current.trim());

  return chunks.map((c, i) =>
    i === 0 ? c : chunks[i - 1].slice(-overlap) + " " + c
  );
}

export async function ingest(rawText: string, source: string) {
  const chunks = chunk(rawText);
  console.log(`split "${source}" into ${chunks.length} chunks`);

  const rows: Row[] = await Promise.all(
    chunks.map(async (text, i) => ({
      id: `${source}-${i}`,
      text,
      source,
      vector: await embed(text),
    }))
  );

  insertRows(rows);
  console.log(`ingested ${rows.length} chunks from "${source}"`);
}

export async function retrieve(query: string): Promise<{ text: string; source: string }[]> {
  const queryVec = await embed(query);
  return hybridSearch(queryVec, query);
}
