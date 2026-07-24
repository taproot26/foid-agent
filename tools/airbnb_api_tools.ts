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

// Hard cap so "top 50 listings" is a guarantee, not something the model has to count pages
// toward itself. Once reached, further pages are refused regardless of what Airbnb still has.
const MAX_LISTINGS = 50;

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
    allListings = result.listings.slice(0, MAX_LISTINGS);
    nextCursor = allListings.length < MAX_LISTINGS ? result.nextCursor : null;
  }
  return JSON.stringify({
    ok: result.ok,
    error: result.error,
    searchUrl: result.searchUrl,
    pageListingCount: result.listings.length,
    totalListingCountSoFar: allListings.length,
    hasNextPage: !!nextCursor,
  });
}

async function airbnbApiNextPage(_params: Record<string, any>): Promise<string> {
  if (!nextCursor) {
    return JSON.stringify({ ok: false, error: "no next page available -- either call airbnb_api_search first, there genuinely are no more pages, or the 50-listing cap has already been reached" });
  }
  const result = await searchAirbnb({ city: lastCity, checkin: lastCheckin, checkout: lastCheckout, cursor: nextCursor });
  if (result.ok) {
    const room = MAX_LISTINGS - allListings.length;
    allListings = [...allListings, ...result.listings.slice(0, room)];
    nextCursor = allListings.length < MAX_LISTINGS ? result.nextCursor : null;
  }
  return JSON.stringify({
    ok: result.ok,
    error: result.error,
    pageListingCount: result.listings.length,
    totalListingCountSoFar: allListings.length,
    hasNextPage: !!nextCursor,
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

// Scores each listing against the group's own median/average -- "good deal relative to
// this batch of 50", not against some fixed external benchmark.
// +1 for above-median rating, +1 for below-median price (per night).
// +2 EXTRA (on top of the above) if it clears BOTH the average rating and average price bar --
// median and average diverge on a skewed distribution (a few $2000/night villas drag the
// average up while the median stays low), so beating both is a stronger signal than either alone.
async function airbnbApiRecommend(_params: Record<string, any>): Promise<string> {
  const nights = nightsBetween(lastCheckin, lastCheckout);
  if (!nights) {
    return JSON.stringify({ ok: false, error: "no valid search in progress -- call airbnb_api_search (and airbnb_api_next_page as needed) first" });
  }

  // Airbnb's own search results occasionally repeat the same listing id across a session
  // (observed directly) -- dedupe so a repeat doesn't eat a recommendation slot.
  const seenIds = new Set<string>();
  const withPricePerNight = allListings
    .filter((l) => typeof l.priceValue === "number" && typeof l.ratingValue === "number")
    .filter((l) => (seenIds.has(l.id) ? false : (seenIds.add(l.id), true)))
    .map((l) => ({ ...l, pricePerNight: (l.priceValue as number) / nights }));

  if (!withPricePerNight.length) {
    return JSON.stringify({ ok: false, error: "no listings with both a price and a rating to score -- call airbnb_api_search first" });
  }

  const prices = withPricePerNight.map((l) => l.pricePerNight).sort((a, b) => a - b);
  const ratings = withPricePerNight.map((l) => l.ratingValue as number).sort((a, b) => a - b);
  const medPrice = median(prices) as number;
  const medRating = median(ratings) as number;
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const avgRating = ratings.reduce((a, b) => a + b, 0) / ratings.length;

  const scored = withPricePerNight.map((l) => {
    const aboveMedianRating = (l.ratingValue as number) > medRating;
    const belowMedianPrice = l.pricePerNight < medPrice;
    const aboveAvgRating = (l.ratingValue as number) > avgRating;
    const belowAvgPrice = l.pricePerNight < avgPrice;

    let score = 0;
    if (aboveMedianRating) score += 1;
    if (belowMedianPrice) score += 1;
    if (aboveAvgRating && belowAvgPrice) score += 2; // extra weighting, only when BOTH average bars are cleared

    return {
      title: l.title,
      subtitle: l.subtitle,
      url: l.url,
      pricePerNight: Math.round(l.pricePerNight),
      rating: l.ratingValue,
      score,
      aboveMedianRating,
      belowMedianPrice,
      aboveAvgRating,
      belowAvgPrice,
    };
  });

  scored.sort((a, b) => b.score - a.score || a.pricePerNight - b.pricePerNight);
  const recommended = scored.filter((s) => s.score > 0);

  return JSON.stringify({
    ok: true,
    poolSize: withPricePerNight.length,
    currency: "USD",
    medianPricePerNight: Math.round(medPrice),
    averagePricePerNight: Math.round(avgPrice),
    medianRating: +medRating.toFixed(2),
    averageRating: +avgRating.toFixed(2),
    recommendedCount: recommended.length,
    topRecommendations: recommended.slice(0, 10),
  });
}

export { airbnbApiSearch, airbnbApiNextPage, airbnbApiGetStats, airbnbApiRecommend };
