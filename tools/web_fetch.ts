export async function webFetch(params: Record<string, any>): Promise<string> {
  const url: string = params.url;
  if (!url) return "missing url param";
  const res = await fetch(url);
  if (!res.ok) return `fetch error: ${res.status}`;
  const html = await res.text();
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
}
