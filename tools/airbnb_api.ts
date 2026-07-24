// Direct-fetch Airbnb search, ported from github.com/openbnb-org/mcp-server-airbnb's
// approach: instead of driving a browser through the search UI (calendar clicks,
// pagination buttons, scroll-to-load), construct the search URL directly and parse
// the JSON Airbnb's own React app embeds in a <script id="data-deferred-state-0">
// tag for its own hydration. No browser, no UI, so no calendar/month/pagination bugs.
import * as cheerio from "cheerio";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BASE_URL = "https://www.airbnb.com";

function cleanObject(obj: any) {
  Object.keys(obj).forEach((key) => {
    if (obj[key] == null || key === "__typename") {
      delete obj[key];
    } else if (typeof obj[key] === "object") {
      cleanObject(obj[key]);
    }
  });
}

interface Coords {
  sw_lat: number; ne_lat: number; sw_lng: number; ne_lng: number; displayName: string;
}

// Airbnb's own server-side geocoding is unreliable for non-US cities, so resolve
// the location ourselves via Photon (OpenStreetMap-backed, no API key, generous limits).
async function geocodeLocation(location: string): Promise<Coords | null> {
  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(location)}&limit=5`;
    const res = await fetch(url, { headers: { "User-Agent": "agent3-airbnb-tool/1.0", Accept: "application/json" } });
    if (!res.ok) return null;
    const data: any = await res.json();
    const feature = data?.features?.[0];
    if (!feature?.properties?.extent || feature.properties.extent.length !== 4) return null;
    const [west, north, east, south] = feature.properties.extent;
    return { sw_lat: south, ne_lat: north, sw_lng: west, ne_lng: east, displayName: feature.properties.name || location };
  } catch {
    return null;
  }
}

export interface Listing {
  id: string;
  url: string;
  title: string | null;
  subtitle: string | null;
  priceLabel: string | null;
  priceValue: number | null;
  priceQualifier: string | null;
  ratingLabel: string | null;
  ratingValue: number | null;
}

export interface SearchResult {
  ok: boolean;
  error?: string;
  searchUrl?: string;
  listings: Listing[];
  nextCursor: string | null;
  totalCursors: number;
}

function parsePrice(label: string | undefined | null): { text: string | null; value: number | null } {
  if (!label) return { text: null, value: null };
  const match = label.match(/[¥$€£][\d,]+/);
  return {
    text: match ? match[0] : null,
    value: match ? parseInt(match[0].replace(/[^\d]/g, ""), 10) : null,
  };
}

function parseRating(label: string | undefined | null): { text: string | null; value: number | null } {
  if (!label) return { text: null, value: null };
  const match = label.match(/([\d.]+)\s*out of 5/);
  return {
    text: match ? match[0] : null,
    value: match ? parseFloat(match[1]) : null,
  };
}

export async function searchAirbnb(params: {
  city: string;
  checkin?: string;
  checkout?: string;
  adults?: number;
  minBedrooms?: number;
  minBathrooms?: number;
  maxBathrooms?: number;
  currency?: string;
  cursor?: string;
}): Promise<SearchResult> {
  const { city, checkin, checkout, adults = 1, minBedrooms, minBathrooms, maxBathrooms, currency = "USD", cursor } = params;

  const slug = city.replace(/,\s*/g, "--").replace(/\s+/g, "-");
  const url = new URL(`${BASE_URL}/s/${encodeURIComponent(slug)}/homes`);

  const coords = await geocodeLocation(city);
  if (coords) {
    url.searchParams.append("ne_lat", String(coords.ne_lat));
    url.searchParams.append("ne_lng", String(coords.ne_lng));
    url.searchParams.append("sw_lat", String(coords.sw_lat));
    url.searchParams.append("sw_lng", String(coords.sw_lng));
  }
  if (checkin) url.searchParams.append("checkin", checkin);
  if (checkout) url.searchParams.append("checkout", checkout);
  url.searchParams.append("adults", String(adults));
  // Without an explicit currency, Airbnb picks one on its own (observed: JPY, for a Thailand
  // search, with no discernible logic) -- always pin it so priceValue is in a known unit.
  url.searchParams.append("currency", currency);
  if (minBedrooms && minBedrooms > 0) url.searchParams.append("min_bedrooms", String(minBedrooms));
  if (minBathrooms && minBathrooms > 0) url.searchParams.append("min_bathrooms", String(minBathrooms));
  if (maxBathrooms && maxBathrooms > 0) url.searchParams.append("max_bathrooms", String(maxBathrooms));
  if (cursor) url.searchParams.append("cursor", cursor);

  let html: string;
  try {
    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, listings: [], nextCursor: null, totalCursors: 0 };
    html = await res.text();
  } catch (e: any) {
    return { ok: false, error: `fetch failed: ${e.message}`, listings: [], nextCursor: null, totalCursors: 0 };
  }

  const $ = cheerio.load(html);
  const scriptEl = $("#data-deferred-state-0").first();
  if (scriptEl.length === 0) {
    return { ok: false, error: "could not find data script element -- page structure may have changed", listings: [], nextCursor: null, totalCursors: 0 };
  }

  try {
    const clientData = JSON.parse($(scriptEl).text());
    const results = clientData.niobeClientData[0][1].data.presentation.staysSearch.results;
    cleanObject(results);

    const listings: Listing[] = results.searchResults.map((r: any) => {
      const id = Buffer.from(r.demandStayListing.id, "base64").toString("utf-8").split(":")[1];
      const priceLabel = r.structuredDisplayPrice?.primaryLine?.accessibilityLabel ?? null;
      const ratingLabel = r.avgRatingA11yLabel ?? null;
      const price = parsePrice(priceLabel);
      const rating = parseRating(ratingLabel);
      return {
        id,
        url: `${BASE_URL}/rooms/${id}`,
        title: r.title ?? null,
        subtitle: r.subtitle ?? null,
        priceLabel: price.text,
        priceValue: price.value,
        // Stays of 28+ nights make Airbnb switch displayPriceStyle to "MONTHLY" (a monthly
        // total, not "for N nights") -- surface this so callers don't assume a nightly figure.
        priceQualifier: r.structuredDisplayPrice?.primaryLine?.qualifier ?? null,
        ratingLabel: rating.text,
        ratingValue: rating.value,
      };
    });

    const cursors: string[] = results.paginationInfo?.pageCursors ?? [];
    const currentIndex = cursor ? cursors.indexOf(cursor) : 0;
    const nextCursor = currentIndex >= 0 && currentIndex + 1 < cursors.length ? cursors[currentIndex + 1] : null;

    return { ok: true, searchUrl: url.toString(), listings, nextCursor, totalCursors: cursors.length };
  } catch (e: any) {
    return { ok: false, error: `failed to parse search results: ${e.message}`, listings: [], nextCursor: null, totalCursors: 0 };
  }
}
