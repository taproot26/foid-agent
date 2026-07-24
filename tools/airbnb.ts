// Wraps the step-based Airbnb scraper (scripts/airbnb_steps.js) as individual
// agent tools. This lets the LLM drive the flow one step at a time, reading
// each step's {ok, ...state} result before deciding what to call next --
// instead of a hardcoded script that barrels through regardless of failures.
import path from "path";

const steps = require(path.resolve(__dirname, "../scripts/airbnb_steps.js"));
const { chromium } = require("playwright");

// module-level singleton: all airbnb_* tool calls in a session share one
// browser tab, since each step depends on the DOM state the previous step left behind.
let browser: any = null;
let page: any = null;
// accumulates listings across every airbnb_scrape_page call so the LLM never has to
// carry raw listing arrays in its own context to compute stats -- it just calls
// airbnb_get_stats once at the end.
let allListings: any[] = [];

// The 14B local model doesn't reliably follow the step order from the prompt alone --
// it has skipped straight from picking a destination to scraping the homepage,
// never opening the calendar or selecting dates at all. Enforce the sequence here,
// at the tool layer, instead of trusting the model to follow instructions.
let destinationConfirmed = false;
let datesConfirmed = false;
let searchClicked = false;

async function ensurePage() {
  if (!browser) {
    browser = await chromium.launch({ headless: false, slowMo: 300 });
    page = await browser.newPage();
  }
  return page;
}

function summarize(result: Record<string, any>): string {
  // trim large fields so the small local model sees a compact status, not a
  // wall of text. This matters a LOT: an earlier version returned the full
  // page-text dump in `whereText` (hundreds of lines), and the 14B model
  // derailed completely -- it stopped emitting real tool calls and started
  // hallucinating fake {"action":...} JSON in plain text. Any string field
  // longer than 120 chars gets truncated here.
  const { listings, ...rest } = result;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (typeof v === "string" && v.length > 120) {
      out[k] = v.slice(0, 120) + "…(truncated)";
    } else {
      out[k] = v;
    }
  }
  if (Array.isArray(listings)) {
    out.listingCount = listings.length;
    out.sampleListings = listings.slice(0, 3);
  }
  return JSON.stringify(out);
}

async function airbnbOpen(_params: Record<string, any>): Promise<string> {
  allListings = []; // fresh session
  destinationConfirmed = false;
  datesConfirmed = false;
  searchClicked = false;
  const p = await ensurePage();
  const result = await steps.gotoAirbnb(p);
  return summarize(result);
}

async function airbnbSearchDestination(params: Record<string, any>): Promise<string> {
  const p = await ensurePage();
  const result = await steps.searchDestination(p, params.city);
  destinationConfirmed = !!result.ok;
  return summarize(result);
}

async function airbnbOpenCalendar(_params: Record<string, any>): Promise<string> {
  if (!destinationConfirmed) {
    return JSON.stringify({ ok: false, error: "destination not confirmed yet -- call airbnb_search_destination first and check it returned ok:true" });
  }
  const p = await ensurePage();
  const result = await steps.openCalendar(p);
  return summarize(result);
}

async function airbnbSelectDates(params: Record<string, any>): Promise<string> {
  if (!destinationConfirmed) {
    return JSON.stringify({ ok: false, error: "destination not confirmed yet -- call airbnb_search_destination and airbnb_open_calendar first" });
  }
  const p = await ensurePage();
  const checkInDay = parseInt(params.checkInDay, 10);
  const checkOutDay = parseInt(params.checkOutDay, 10);
  const result = await steps.selectDates(p, checkInDay, checkOutDay, params.monthName);
  datesConfirmed = !!result.ok;
  return summarize(result);
}

async function airbnbClickSearch(_params: Record<string, any>): Promise<string> {
  if (!datesConfirmed) {
    return JSON.stringify({ ok: false, error: "dates not confirmed yet -- call airbnb_open_calendar then airbnb_select_dates first, and check airbnb_select_dates returned ok:true before clicking search" });
  }
  const p = await ensurePage();
  const result = await steps.clickSearch(p);
  searchClicked = !!result.ok;
  return summarize(result);
}

async function airbnbScrapePage(_params: Record<string, any>): Promise<string> {
  if (!searchClicked) {
    return JSON.stringify({ ok: false, error: "search was never clicked -- this would scrape homepage recommendations, not real search results. Go back and complete airbnb_search_destination -> airbnb_open_calendar -> airbnb_select_dates -> airbnb_click_search first, in that order." });
  }
  const p = await ensurePage();
  const result = await steps.scrapeCurrentPage(p);
  if (result.ok && Array.isArray(result.listings)) {
    allListings = [...allListings, ...result.listings];
  }
  return JSON.stringify({
    ok: result.ok,
    pageListingCount: result.listings?.length ?? 0,
    totalListingCountSoFar: allListings.length,
  });
}

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 !== 0 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

async function airbnbGetStats(_params: Record<string, any>): Promise<string> {
  const prices = allListings
    .map((l) => l.priceValue)
    .filter((v) => typeof v === "number" && !isNaN(v))
    .sort((a, b) => a - b);
  const ratings = allListings
    .map((l) => l.ratingValue)
    .filter((v) => typeof v === "number" && !isNaN(v))
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

async function airbnbNextPage(params: Record<string, any>): Promise<string> {
  const p = await ensurePage();
  const targetPageNumber = parseInt(params.targetPageNumber, 10) || 2;
  const result = await steps.goToNextPage(p, targetPageNumber);
  return summarize(result);
}

async function airbnbClose(_params: Record<string, any>): Promise<string> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
  }
  return JSON.stringify({ ok: true, closed: true });
}

export {
  airbnbOpen,
  airbnbSearchDestination,
  airbnbOpenCalendar,
  airbnbSelectDates,
  airbnbClickSearch,
  airbnbScrapePage,
  airbnbNextPage,
  airbnbGetStats,
  airbnbClose,
};
