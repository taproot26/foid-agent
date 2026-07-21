export async function webSearch(params: Record<string, any>): Promise<string> {
  const query: string = params.query;
  if (!query) return "missing query param";

  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) return `search error: ${res.status}`;

  const html = await res.text();

  const titles = [...html.matchAll(/class='result-link'[^>]*>([\s\S]*?)<\/a>/g)]
    .map(m => m[1].replace(/<[^>]+>/g, '').trim())
    .filter(Boolean)
    .slice(0, 5);

  const snippets = [...html.matchAll(/class='result-snippet'[^>]*>([\s\S]*?)<\/td>/g)]
    .map(m => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 5);

  const results: string[] = [];
  for (let i = 0; i < Math.max(titles.length, snippets.length); i++) {
    const parts = [titles[i], snippets[i]].filter(Boolean);
    if (parts.length) results.push(parts.join('\n'));
  }

  return results.length ? results.join('\n\n') : "no results found";
}
