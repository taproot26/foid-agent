# agent3

A small local agent harness: RAG (hybrid vector + keyword search) + tool-calling loop, backed by any OpenAI-compatible LLM API.

## Setup

1. Install dependencies:
   ```
   npm install
   npx playwright install chromium
   ```

2. Copy the example config files and fill in your own values:
   ```
   cp .env.example .env
   cp profile.example.json profile.data.json
   ```
   - `.env` — set `GROQ_API_KEY` to your own key ([console.groq.com](https://console.groq.com), free, no card needed). To use a different provider, edit `LLM_URL` and `CHAT_MODEL` in `config.ts`.
   - `profile.data.json` — your name/email/job. Tools like `luma_register` use this automatically so you don't have to repeat it every request.

3. Start the server:
   ```
   npm start
   ```
   Runs on `http://localhost:3000`.

## Usage

```
POST /chat    { "message": "..." }
POST /ingest  { "text": "...", "source": "..." }
```

There's also a React frontend in `frontend/` (`cd frontend && npm install && npm run dev`) if you want a chat UI instead of curling the API directly.

## What's in here

- **RAG** (`rag/`, `db/vec.ts`) — chunks + embeds ingested text (local MiniLM model, no API needed), stores vectors + a keyword (FTS5) index in SQLite, retrieves via hybrid search (vector + BM25, merged with reciprocal rank fusion) with an irrelevance cutoff.
- **Tools** (`tools/`) — `web_search`, `web_fetch`, `calculator`, `search_knowledge`, `get_recent_history`, `luma_register` (event RSVP via headless browser — note: this will hit Luma's bot-check on most real events and can't get past it, see `tools/luma_register.ts`).
- **Logging** (`db/sqlite.ts`) — every request, retrieved context, and tool call is logged to `logs.db` for later inspection/fine-tuning data.

## Notes

- `logs.db` and `rag-vec.db` are gitignored — they're local data, not source.
- `luma_register` opens a real browser and can submit a real registration; only call it when you actually mean to register for something.
