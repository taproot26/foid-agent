// Wraps searchAirbnb (tools/airbnb_api.ts) as agent tools -- a parallel, no-browser
// alternative to the Playwright-driven airbnb_* tools in tools/airbnb.ts. Same "airbnb"
// agent, separate tool set: no calendar/month-picker UI exists here, so an entire class
// of bugs (wrong month, map clicks, flaky "Add dates" click) is structurally impossible.
import { searchAirbnb, Listing } from "./airbnb_api";

// module-level accumulator, same pattern as tools/airbnb.ts: the LLM never carries raw
// listing arrays in its own context, it just calls airbnb_api_get_stats once at the end.
let allListings: Listing[] = [];
let lastCity = "";
let lastCheckin = "";
let lastCheckout = "";
let nextCursor: string | null = null;

async function airbnbApiSearch(params: Record<string, any>): Promise<string> {
  allListings = [];
  nextCursor = null;
  lastCity = params.city;
  lastCheckin = params.checkin;
  lastCheckout = params.checkout;

  const result = await searchAirbnb({ city: lastCity, checkin: lastCheckin, checkout: lastCheckout });
  if (result.ok) {
    allListings = [...result.listings];
    nextCursor = result.nextCursor;
  }
  return JSON.stringify({
    ok: result.ok,
    error: result.error,
    pageListingCount: result.listings.length,
    totalListingCountSoFar: allListings.length,
    hasNextPage: !!result.nextCursor,
  });
}

async function airbnbApiNextPage(_params: Record<string, any>): Promise<string> {
  if (!nextCursor) {
    return JSON.stringify({ ok: false, error: "no next page available -- call airbnb_api_search first, or there genuinely are no more pages" });
  }
  const result = await searchAirbnb({ city: lastCity, checkin: lastCheckin, checkout: lastCheckout, cursor: nextCursor });
  if (result.ok) {
    allListings = [...allListings, ...result.listings];
    nextCursor = result.nextCursor;
  }
  return JSON.stringify({
    ok: result.ok,
    error: result.error,
    pageListingCount: result.listings.length,
    totalListingCountSoFar: allListings.length,
    hasNextPage: !!result.nextCursor,
  });
}

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 !== 0 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

async function airbnbApiGetStats(_params: Record<string, any>): Promise<string> {
  const prices = allListings
    .map((l) => l.priceValue)
    .filter((v): v is number => typeof v === "number" && !isNaN(v))
    .sort((a, b) => a - b);
  const ratings = allListings
    .map((l) => l.ratingValue)
    .filter((v): v is number => typeof v === "number" && !isNaN(v))
    .sort((a, b) => a - b);

  return JSON.stringify({
    ok: allListings.length > 0,
    totalListings: allListings.length,
    averagePrice: prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null,
    medianPrice: median(prices) !== null ? Math.round(median(prices) as number) : null,
    averageRating: ratings.length ? +(ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2) : null,
    medianRating: median(ratings) !== null ? +(median(ratings) as number).toFixed(2) : null,
  });
}

export { airbnbApiSearch, airbnbApiNextPage, airbnbApiGetStats };
