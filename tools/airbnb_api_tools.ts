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

function nightsBetween(checkin: string, checkout: string): number | null {
  const inDate = new Date(checkin);
  const outDate = new Date(checkout);
  if (isNaN(inDate.getTime()) || isNaN(outDate.getTime())) return null;
  const nights = Math.round((outDate.getTime() - inDate.getTime()) / (1000 * 60 * 60 * 24));
  return nights > 0 ? nights : null;
}

async function airbnbApiSearch(params: Record<string, any>): Promise<string> {
  allListings = [];
  nextCursor = null;
  lastCity = params.city;
  lastCheckin = params.checkin;
  lastCheckout = params.checkout;
  const minBedrooms = parseInt(params.minBedrooms || "0", 10);
  const minBathrooms = parseInt(params.minBathrooms || "0", 10);
  const maxBathrooms = parseInt(params.maxBathrooms || "0", 10);

  const result = await searchAirbnb({
    city: lastCity,
    checkin: lastCheckin,
    checkout: lastCheckout,
    ...(minBedrooms > 0 && { minBedrooms }),
    ...(minBathrooms > 0 && { minBathrooms }),
    ...(maxBathrooms > 0 && { maxBathrooms }),
  });
  if (result.ok) {
    allListings = [...result.listings];
    nextCursor = result.nextCursor;
  }
  return JSON.stringify({
    ok: result.ok,
    error: result.error,
    searchUrl: result.searchUrl,
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

  const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  const medPrice = median(prices);
  const avgRating = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
  const medRating = median(ratings);
  // Airbnb's price label is the TOTAL for the whole stay (e.g. "$647 for 7 nights"), not a
  // nightly rate -- divide by nights so stats are comparable across different trip lengths.
  const nights = nightsBetween(lastCheckin, lastCheckout);

  return JSON.stringify({
    ok: allListings.length > 0,
    totalListings: allListings.length,
    currency: "USD",
    nights,
    averageTotalPrice: avgPrice ? Math.round(avgPrice) : null,
    medianTotalPrice: medPrice ? Math.round(medPrice as number) : null,
    averagePricePerNight: avgPrice && nights ? Math.round(avgPrice / nights) : null,
    medianPricePerNight: medPrice && nights ? Math.round((medPrice as number) / nights) : null,
    averageRating: avgRating ? +(avgRating).toFixed(2) : null,
    medianRating: medRating ? +(medRating as number).toFixed(2) : null,
  });
}

export { airbnbApiSearch, airbnbApiNextPage, airbnbApiGetStats };
