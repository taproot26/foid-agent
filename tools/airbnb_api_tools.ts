// Wraps searchAirbnb (tools/airbnb_api.ts) as agent tools -- a parallel, no-browser
// alternative to the Playwright-driven airbnb_* tools in tools/airbnb.ts. Same "airbnb"
// agent, separate tool set: no calendar/month-picker UI exists here, so an entire class
// of bugs (wrong month, map clicks, flaky "Add dates" click) is structurally impossible.
//
// Originally this was 4 separate tools (search, next_page, get_stats, recommend) that the
// LLM had to call in sequence across multiple round-trips. On the local 14B model that meant
// 3-6 LLM iterations per request (~2-4 minutes) and repeated derailments: it picked get_stats
// over recommend, hallucinated a different city partway through, or repeated a call. All of
// that was tool-ORDERING confusion, not a capability gap -- the whole sequence is always the
// same fixed pipeline (search -> paginate to the cap -> score), so there's nothing for the
// model to decide. Collapsed to 2 self-contained tools: one LLM call, one tool call, done.
import { searchAirbnb, Listing } from "./airbnb_api";

// Hard cap so "top 50 listings" is a guarantee. Airbnb serves ~18/page, so this pages
// internally (server-side, no model round trip) until the cap or the results run out.
const MAX_LISTINGS = 50;

function nightsBetween(checkin: string, checkout: string): number | null {
  const inDate = new Date(checkin);
  const outDate = new Date(checkout);
  if (isNaN(inDate.getTime()) || isNaN(outDate.getTime())) return null;
  const nights = Math.round((outDate.getTime() - inDate.getTime()) / (1000 * 60 * 60 * 24));
  return nights > 0 ? nights : null;
}

// The local model's training cutoff biases it toward stale years (observed repeatedly
// passing "2023" regardless of prompt instructions telling it to use 2026+) -- prompt text
// alone doesn't fix this reliably, so correct it deterministically here instead, the same way
// tools/airbnb.ts reads the calendar's actual visible months rather than trusting the model's
// guessed year. If checkin has already passed, shift BOTH checkin and checkout forward by
// whole years (preserving month/day and the gap between them) until checkin is in the future.
function shiftToFuture(checkin: string, checkout: string): { checkin: string; checkout: string; yearsShifted: number } {
  const m = checkin.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const mOut = checkout.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || !mOut) return { checkin, checkout, yearsShifted: 0 };

  const today = new Date();
  let year = parseInt(m[1], 10);
  const yearOut = parseInt(mOut[1], 10);
  const yearGap = yearOut - year;
  let yearsShifted = 0;

  const checkinDate = () => new Date(`${year}-${m[2]}-${m[3]}`);
  while (checkinDate() < today) {
    year += 1;
    yearsShifted += 1;
  }

  if (yearsShifted === 0) return { checkin, checkout, yearsShifted: 0 };
  return {
    checkin: `${year}-${m[2]}-${m[3]}`,
    checkout: `${year + yearGap}-${mOut[2]}-${mOut[3]}`,
    yearsShifted,
  };
}

interface Pool {
  ok: boolean;
  error?: string;
  listings: Listing[];
  searchUrl?: string;
  checkin: string;
  checkout: string;
  note?: string;
}

// Does search + all pagination server-side, no LLM round trip in between.
async function fetchPool(params: Record<string, any>): Promise<Pool> {
  const shifted = shiftToFuture(params.checkin, params.checkout);
  const minBedrooms = parseInt(params.minBedrooms || "0", 10);
  const minBathrooms = parseInt(params.minBathrooms || "0", 10);
  const maxBathrooms = parseInt(params.maxBathrooms || "0", 10);
  const note = shifted.yearsShifted > 0
    ? `you passed a past date, auto-corrected forward by ${shifted.yearsShifted} year(s) to the next future occurrence`
    : undefined;

  const first = await searchAirbnb({
    city: params.city,
    checkin: shifted.checkin,
    checkout: shifted.checkout,
    ...(minBedrooms > 0 && { minBedrooms }),
    ...(minBathrooms > 0 && { minBathrooms }),
    ...(maxBathrooms > 0 && { maxBathrooms }),
  });
  if (!first.ok) {
    return { ok: false, error: first.error, listings: [], checkin: shifted.checkin, checkout: shifted.checkout, note };
  }

  let listings = first.listings.slice(0, MAX_LISTINGS);
  let cursor = listings.length < MAX_LISTINGS ? first.nextCursor : null;

  while (cursor && listings.length < MAX_LISTINGS) {
    const next = await searchAirbnb({ city: params.city, checkin: shifted.checkin, checkout: shifted.checkout, cursor });
    if (!next.ok) break;
    const room = MAX_LISTINGS - listings.length;
    listings = [...listings, ...next.listings.slice(0, room)];
    cursor = listings.length < MAX_LISTINGS ? next.nextCursor : null;
  }

  return { ok: true, listings, searchUrl: first.searchUrl, checkin: shifted.checkin, checkout: shifted.checkout, note };
}

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 !== 0 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

async function airbnbApiStats(params: Record<string, any>): Promise<string> {
  const pool = await fetchPool(params);
  if (!pool.ok) return JSON.stringify({ ok: false, error: pool.error });

  const nights = nightsBetween(pool.checkin, pool.checkout);
  const prices = pool.listings
    .map((l) => l.priceValue)
    .filter((v): v is number => typeof v === "number" && !isNaN(v))
    .sort((a, b) => a - b);
  const ratings = pool.listings
    .map((l) => l.ratingValue)
    .filter((v): v is number => typeof v === "number" && !isNaN(v))
    .sort((a, b) => a - b);

  const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  const medPrice = median(prices);
  const avgRating = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
  const medRating = median(ratings);

  return JSON.stringify({
    ok: pool.listings.length > 0,
    searchUrl: pool.searchUrl,
    datesUsed: { checkin: pool.checkin, checkout: pool.checkout },
    ...(pool.note && { note: pool.note }),
    totalListings: pool.listings.length,
    currency: "USD",
    nights,
    // Airbnb's price label is the TOTAL for the whole stay, not a nightly rate --
    // divide by nights so this is comparable across different trip lengths.
    averageTotalPrice: avgPrice ? Math.round(avgPrice) : null,
    medianTotalPrice: medPrice ? Math.round(medPrice as number) : null,
    averagePricePerNight: avgPrice && nights ? Math.round(avgPrice / nights) : null,
    medianPricePerNight: medPrice && nights ? Math.round((medPrice as number) / nights) : null,
    averageRating: avgRating ? +(avgRating).toFixed(2) : null,
    medianRating: medRating ? +(medRating as number).toFixed(2) : null,
  });
}

const mean = (arr: number[]): number => arr.reduce((a, b) => a + b, 0) / arr.length;
const stdev = (arr: number[], m: number): number => {
  if (arr.length < 2) return 0;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
};
// z-score standardizes a value against the batch's own distribution ("how many std devs
// from the mean"). std=0 (every listing identical on this axis) -> 0, so it drops out of
// the composite instead of dividing by zero.
const zscore = (x: number, m: number, sd: number): number => (sd === 0 ? 0 : (x - m) / sd);

// Minimum reviews to be eligible at all -- fewer than this is too noisy to trust (also
// where "outlier/noise" listings get thrown out, per the scoring rules below).
const MIN_REVIEWS = 5;
// Bayesian shrinkage strength: a listing needs ~BAYES_M reviews before its own rating
// outweighs the pool mean. A 5.0 with 5 reviews gets pulled toward the pool average;
// a 4.9 with 400 reviews barely moves. (IMDB Top 250 "weighted rating" trick.)
const BAYES_M = 20;

// Composite value score built on the batch's own distribution (a "good deal relative to
// THIS pool", not an absolute benchmark). Three standardized components:
//   ratingZ  = z-score of the Bayesian-adjusted rating   (reward genuinely well-liked places)
//   priceZ   = z-score of log(price-per-night)           (reward cheap; enters with a minus. log
//                                                          because nightly price is heavily right-
//                                                          skewed -- a few luxury villas otherwise
//                                                          blow up the std and flatten priceZ for
//                                                          every affordable listing into ~0)
//   reviewsZ = z-score of log(reviewsCount)              (reward proven/popular places; log so
//                                                          400-vs-40 reviews doesn't dwarf everything)
// score = 1.0*ratingZ - 1.0*priceZ + 0.5*reviewsZ
// Rating and price weigh equally; review volume is a half-weight secondary boost on top of
// the shrinkage already baked into the Bayesian rating.
const W_RATING = 1.0;
const W_PRICE = 1.0;
const W_REVIEWS = 0.5;

async function airbnbApiRecommendTop5(params: Record<string, any>): Promise<string> {
  const pool = await fetchPool(params);
  if (!pool.ok) return JSON.stringify({ ok: false, error: pool.error });

  const nights = nightsBetween(pool.checkin, pool.checkout);
  if (!nights) return JSON.stringify({ ok: false, error: "invalid checkin/checkout dates" });

  // dedupe (Airbnb repeats listing ids), then throw out noise: missing price/rating, or
  // fewer than MIN_REVIEWS reviews (too few to trust as a real signal).
  const seenIds = new Set<string>();
  const clean = pool.listings
    .filter((l) => (seenIds.has(l.id) ? false : (seenIds.add(l.id), true)))
    .filter((l) =>
      typeof l.priceValue === "number" &&
      typeof l.ratingValue === "number" &&
      typeof l.reviewsCount === "number" &&
      (l.reviewsCount as number) >= MIN_REVIEWS
    )
    .map((l) => ({
      ...l,
      pricePerNight: (l.priceValue as number) / nights,
      rating: l.ratingValue as number,
      reviews: l.reviewsCount as number,
    }));

  if (clean.length < 2) {
    return JSON.stringify({
      ok: false,
      error: `not enough qualifying listings to score (need >=2 with a price, rating, and >=${MIN_REVIEWS} reviews; found ${clean.length}). The search was too narrow.`,
    });
  }

  // Bayesian-adjusted rating: pull low-review ratings toward the pool mean
  const poolMeanRating = mean(clean.map((l) => l.rating));
  const adjusted = clean.map((l) => {
    const v = l.reviews;
    const adjRating = (v / (v + BAYES_M)) * l.rating + (BAYES_M / (v + BAYES_M)) * poolMeanRating;
    return { ...l, adjRating, logPrice: Math.log(l.pricePerNight), logReviews: Math.log(l.reviews) };
  });

  const mAdjR = mean(adjusted.map((l) => l.adjRating));
  const sdAdjR = stdev(adjusted.map((l) => l.adjRating), mAdjR);
  const mLogPrice = mean(adjusted.map((l) => l.logPrice));
  const sdLogPrice = stdev(adjusted.map((l) => l.logPrice), mLogPrice);
  const mLogRev = mean(adjusted.map((l) => l.logReviews));
  const sdLogRev = stdev(adjusted.map((l) => l.logReviews), mLogRev);

  const scored = adjusted.map((l) => {
    const ratingZ = zscore(l.adjRating, mAdjR, sdAdjR);
    const priceZ = zscore(l.logPrice, mLogPrice, sdLogPrice);
    const reviewsZ = zscore(l.logReviews, mLogRev, sdLogRev);
    const score = W_RATING * ratingZ - W_PRICE * priceZ + W_REVIEWS * reviewsZ;
    return {
      title: l.title,
      subtitle: l.subtitle,
      url: l.url,
      pricePerNight: Math.round(l.pricePerNight),
      rating: l.rating,
      reviews: l.reviews,
      score: +score.toFixed(3),
    };
  });

  scored.sort((a, b) => b.score - a.score);

  return JSON.stringify({
    ok: true,
    searchUrl: pool.searchUrl,
    datesUsed: { checkin: pool.checkin, checkout: pool.checkout },
    ...(pool.note && { note: pool.note }),
    poolSize: clean.length,
    excludedAsNoise: pool.listings.length - clean.length,
    currency: "USD",
    nights,
    formula: "score = 1.0*z(bayesianRating) - 1.0*z(log(pricePerNight)) + 0.5*z(log(reviews)); rating shrunk toward pool mean; listings with <5 reviews thrown out as noise",
    poolMeanRating: +poolMeanRating.toFixed(2),
    poolMedianPricePerNight: Math.round(median(clean.map((l) => l.pricePerNight)) as number),
    top5: scored.slice(0, 5),
  });
}

export { airbnbApiStats, airbnbApiRecommendTop5 };
