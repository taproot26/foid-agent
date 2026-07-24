import { ingest } from "../rag";
import { webFetch } from "./web_fetch";

export async function ingestUrl(params: Record<string, any>): Promise<string> {
  const url: string = params.url;
  const description: string = params.description;

  if (!url || !description) return "missing url or description";

  try {
    // fetch the content
    const content = await webFetch({ url });
    if (content.includes("error") || content.length < 50) {
      return `failed to fetch ${url}: ${content}`;
    }

    // ingest it with the description as source
    await ingest(content, `${description} (from ${url})`);
    return `ingested ${url}: ${content.length} chars added to knowledge base`;
  } catch (e: any) {
    return `ingest error: ${e.message}`;
  }
}

export async function findSourceMaterial(params: Record<string, any>): Promise<string> {
  const topic: string = params.topic;
  const purpose: string = params.purpose;

  if (!topic || !purpose) return "missing topic or purpose";

  try {
    // search for relevant resources
    const searchQuery = `${topic} documentation tutorial examples ${purpose}`;
    const webSearch = (await import("./web_search")).webSearch;
    const searchResults = await webSearch({ query: searchQuery });

    if (searchResults.includes("error") || !searchResults) {
      return `search failed for ${topic}`;
    }

    // parse results and fetch top ones
    const lines = searchResults.split("\n").filter(l => l.includes("http"));
    const urls: string[] = [];

    for (const line of lines.slice(0, 3)) {
      const match = line.match(/(https?:\/\/[^\s]+)/);
      if (match) urls.push(match[1]);
    }

    if (urls.length === 0) {
      return `no URLs found in search results for ${topic}`;
    }

    // fetch and ingest each URL
    const results: string[] = [];
    for (const url of urls) {
      try {
        const content = await webFetch({ url });
        if (content.length > 100 && !content.includes("error")) {
          await ingest(content, `${topic}: ${purpose} (from ${url})`);
          results.push(`✓ ingested ${url} (${content.length} chars)`);
        } else {
          results.push(`✗ skipped ${url} (too short or error)`);
        }
      } catch (e) {
        results.push(`✗ failed to fetch ${url}`);
      }
    }

    return `Found and ingested ${topic} resources:\n${results.join("\n")}`;
  } catch (e: any) {
    return `find_source_material error: ${e.message}`;
  }
}
