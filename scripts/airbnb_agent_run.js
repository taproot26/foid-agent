const { chromium } = require("playwright");
const steps = require("./airbnb_steps");

// Driver loop: call one step, check its returned `ok` state, decide whether
// to continue or stop. Today the "decide" logic is a simple if/else; this is
// the seam where an LLM could later look at the same state object and choose
// retry / adjust / abort instead.
async function runStep(name, fn) {
  console.log(`\n--- STEP: ${name} ---`);
  const result = await fn();
  console.log(`--- STEP RESULT: ${name} -> ok=${result.ok} ---`);
  return result;
}

async function main() {
  const city = process.argv[2] || "Bangkok, Thailand";
  const checkInDay = parseInt(process.argv[3], 10) || 3;
  const checkOutDay = parseInt(process.argv[4], 10) || 10;
  const monthName = process.argv[5] || "September 2026";

  const browser = await chromium.launch({ headless: false, slowMo: 400 });
  const page = await browser.newPage();

  const r1 = await runStep("gotoAirbnb", () => steps.gotoAirbnb(page));
  if (!r1.ok) {
    console.log("ABORT: could not load Airbnb homepage.");
    await browser.close();
    return;
  }

  const r2 = await runStep("searchDestination", () => steps.searchDestination(page, city));
  if (!r2.ok) {
    console.log("ABORT: destination was not confirmed in the Where field.", r2);
    await page.screenshot({ path: "/tmp/agent_run_fail_destination.png" }).catch(() => {});
    await browser.close();
    return;
  }

  const r3 = await runStep("openCalendar", () => steps.openCalendar(page));
  if (!r3.ok) {
    console.log("ABORT: calendar never opened.", r3);
    await browser.close();
    return;
  }

  const r4 = await runStep("selectDates", () => steps.selectDates(page, checkInDay, checkOutDay, monthName));
  if (!r4.ok) {
    console.log("ABORT: dates did not confirm.", r4);
    await page.screenshot({ path: "/tmp/agent_run_fail_dates.png" }).catch(() => {});
    await browser.close();
    return;
  }

  const r5 = await runStep("clickSearch", () => steps.clickSearch(page));
  if (!r5.ok) {
    console.log("ABORT: search click did not land on a results page.", r5);
    await browser.close();
    return;
  }

  const r6 = await runStep("scrapeCurrentPage (page 1)", () => steps.scrapeCurrentPage(page));
  if (!r6.ok) {
    console.log("ABORT: no listings found on page 1.", r6);
    await browser.close();
    return;
  }
  let allListings = [...r6.listings];
  console.log(`Page 1: ${r6.listings.length} listings`);

  const r7 = await runStep("goToNextPage", () => steps.goToNextPage(page, 2));
  if (r7.ok) {
    const r8 = await runStep("scrapeCurrentPage (page 2)", () => steps.scrapeCurrentPage(page));
    if (r8.ok) {
      allListings = [...allListings, ...r8.listings];
      console.log(`Page 2: ${r8.listings.length} listings`);
    } else {
      console.log("NOTE: page 2 navigation succeeded but no listings scraped -- keeping page 1 results only.");
    }
  } else {
    console.log("NOTE: no page 2 -- proceeding with page 1 results only.");
  }

  const prices = allListings.map((l) => l.priceValue).filter((v) => typeof v === "number" && !isNaN(v)).sort((a, b) => a - b);
  const ratings = allListings.map((l) => l.ratingValue).filter((v) => typeof v === "number" && !isNaN(v)).sort((a, b) => a - b);

  function median(arr) {
    if (!arr.length) return null;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 !== 0 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  const medianPrice = median(prices);
  const avgRating = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
  const medianRating = median(ratings);

  console.log(`\n=== All ${allListings.length} listings ===`);
  console.log(JSON.stringify(allListings.map(({ name, price, rating }) => ({ name, price, rating })), null, 2));

  console.log("\n=== Summary ===");
  console.log(`Total listings scraped: ${allListings.length}`);
  console.log(`Average price: ${avgPrice ? "¥" + Math.round(avgPrice).toLocaleString() : "N/A"} (from ${prices.length} listings)`);
  console.log(`Median price: ${medianPrice ? "¥" + Math.round(medianPrice).toLocaleString() : "N/A"}`);
  console.log(`Average rating: ${avgRating ? avgRating.toFixed(2) : "N/A"} (from ${ratings.length} listings)`);
  console.log(`Median rating: ${medianRating ? medianRating.toFixed(2) : "N/A"}`);

  await steps.sleep(15000);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
