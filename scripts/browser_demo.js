const { chromium } = require("playwright");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const city = process.argv[2] || "Kyoto";
  const checkInDay = parseInt(process.argv[3], 10) || 1;
  const checkOutDay = parseInt(process.argv[4], 10) || 7;
  const monthName = process.argv[5] || "August 2026";

  const browser = await chromium.launch({ headless: false, slowMo: 400 });
  const page = await browser.newPage();

  // Airbnb pops promo modals ("Save 50% on getaways...") at unpredictable
  // points in the flow -- on load, mid-typing, after selecting a suggestion.
  // Call this before every step that could get blocked by one.
  async function closeAnyModal(label) {
    const modal = page.locator('[data-testid="modal-container"]');
    if (await modal.count() === 0) return false;
    console.log(`  modal detected${label ? " (" + label + ")" : ""}, closing ...`);
    const closeBtn = page.getByRole("button", { name: "Close" }).first();
    if (await closeBtn.count() > 0) {
      await closeBtn.click({ force: true }).catch(() => {});
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
    await sleep(600);
    return true;
  }

  await page.goto("https://www.airbnb.com");
  await sleep(1500);
  await closeAnyModal("initial load");

  console.log(`typing ${city} into Where field ...`);
  const whereField = page.getByPlaceholder("Search destinations");
  await whereField.click();
  await whereField.type(city, { delay: 120 });
  await sleep(1500);
  await closeAnyModal("after typing city");

  console.log("selecting first suggestion ...");
  // Wait for the suggestion to be present AND wait for any overlay images to finish loading
  // (Airbnb shows a banner image that can block clicks on suggestions momentarily)
  for (let attempt = 0; attempt < 3; attempt++) {
    const opt = page.locator('[role="option"]').first();
    if (await opt.count() > 0) {
      await sleep(800); // let any overlays clear
      await opt.click({ force: true }).catch((e) => {
        console.log(`  suggestion click attempt ${attempt + 1} failed:`, e.message);
      });
      await sleep(800);
      break;
    }
    console.log("  suggestion not visible yet, waiting ...");
    await sleep(500);
  }
  await closeAnyModal("after selecting suggestion");

  console.log("clicking Add dates to open the calendar ...");
  let calendarOpen = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    await closeAnyModal(`before Add dates attempt ${attempt + 1}`);
    // the click itself is flaky (widget can be mid-transition after picking
    // the destination), so re-click on every retry, not just wait longer.
    await page.getByText("Add dates", { exact: true }).first().click({ force: true }).catch((e) =>
      console.log("  Add dates click attempt failed:", e.message)
    );
    await sleep(1500);
    const anyDay = page.locator("button", { hasText: /^1$/ });
    if (await anyDay.count() > 0) {
      console.log("calendar confirmed open (found day buttons).");
      calendarOpen = true;
      break;
    }
    console.log(`calendar not visible yet after click attempt ${attempt + 1}, retrying ...`);
  }
  if (!calendarOpen) {
    console.log("WARNING: calendar never opened after 5 attempts. Stopping for inspection.");
    await page.screenshot({ path: "/tmp/calendar_never_opened.png" });
    await sleep(30000);
    await browser.close();
    return;
  }
  await sleep(1500);

  async function clickDay(dayNumber, label, monthName) {
    console.log(`looking for day "${dayNumber}" (${label}) in ${monthName} ...`);

    // advance the calendar forward (up to 6 months) until the target month's
    // header is actually visible, so we don't accidentally click the same
    // day-number in the wrong (currently-shown) month.
    let monthFound = false;
    for (let advance = 0; advance < 6; advance++) {
      const monthHeaderVisible = await page.getByText(monthName, { exact: false }).first().isVisible().catch(() => false);
      if (monthHeaderVisible) {
        monthFound = true;
        console.log(`  ✓ ${monthName} is now visible.`);
        break;
      }
      console.log(`  ${monthName} not visible yet (attempt ${advance + 1}), clicking next month ...`);
      const nextBtn = page.getByRole("button", { name: /next month/i }).first();
      if (await nextBtn.count() === 0) {
        console.log(`  ✗ Could not find next-month button.`);
        break;
      }
      await nextBtn.click().catch(() => {});
      await sleep(900);
    }

    if (!monthFound) {
      console.log(`  ERROR: ${monthName} never appeared after advancing 6 times. Staying open for inspection.`);
      await page.screenshot({ path: "/tmp/month_not_found.png" });
      await sleep(30000);
      await browser.close();
      return false;
    }

    // scope the search to the block under the correct month header so we
    // never click a same-numbered day in an adjacent, wrong month.
    const monthHeader = page.getByText(monthName, { exact: false }).first();
    const monthBox = await monthHeader.boundingBox().catch(() => null);

    const candidates = page.locator("button", { hasText: new RegExp(`^${dayNumber}$`) });
    const count = await candidates.count();
    console.log(`  found ${count} candidate button(s) total on the page`);
    for (let i = 0; i < count; i++) {
      const btn = candidates.nth(i);
      const disabled = await btn.getAttribute("aria-disabled");
      const visible = await btn.isVisible().catch(() => false);
      const box = await btn.boundingBox().catch(() => null);
      const inRightMonth = monthBox && box ? Math.abs(box.x - monthBox.x) < 400 : true;
      console.log(`  candidate ${i}: disabled=${disabled}, visible=${visible}, inRightMonth=${inRightMonth}`);
      if (disabled !== "true" && visible && inRightMonth) {
        await btn.scrollIntoViewIfNeeded();
        await sleep(600);
        await btn.hover();
        console.log(`  hovering over ${label} for 1.5s before clicking ...`);
        await sleep(1500);
        await btn.click();
        console.log(`  clicked ${label}.`);
        return true;
      }
    }
    console.log(`  no enabled/visible candidate found for ${label}.`);
    return false;
  }

  const checkInOk = await clickDay(checkInDay, `check-in (day ${checkInDay})`, monthName);
  console.log("pausing 2.5s between check-in and check-out clicks ...");
  await sleep(2500);
  const checkOutOk = await clickDay(checkOutDay, `check-out (day ${checkOutDay})`, monthName);
  console.log("pausing 2.5s after selecting both dates ...");
  await sleep(2500);

  if (!checkInOk || !checkOutOk) {
    console.log("WARNING: at least one date click did not find a target. Stopping here for inspection.");
    await page.screenshot({ path: "/tmp/date_click_failure.png" });
    await sleep(30000);
    await browser.close();
    return;
  }

  // confirm both dates actually took before doing anything else.
  // Airbnb replaces "Add dates" text with the real date range once both
  // check-in and check-out are selected.
  const whenText = await page.locator('div:has-text("When")').first().innerText().catch(() => "");
  console.log("When field now shows:", JSON.stringify(whenText));

  const stillShowsPlaceholder = whenText.includes("Add dates") || whenText.includes("Check in") || whenText.includes("Check out");

  if (stillShowsPlaceholder) {
    console.log("dates do not look confirmed yet -- NOT clicking search. Staying open so you can check.");
    await sleep(30000);
    await browser.close();
    return;
  }

  console.log("dates look confirmed -- clicking Search.");
  await page.getByRole("button", { name: "Search" }).first().click({ timeout: 5000 }).catch((e) =>
    console.log("search click failed:", e.message)
  );

  console.log("waiting for results page to load ...");
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(2500);

  console.log("closing modal on results page if present ...");
  const resultsCloseBtn = page.getByRole("button", { name: "Close" }).first();
  if (await resultsCloseBtn.count() > 0) {
    await resultsCloseBtn.click({ force: true }).catch(() => {});
    await sleep(500);
  }

  async function scrapeCurrentPage() {
    // scroll down to trigger lazy-loaded cards further down the page.
    // Use window.scrollBy (not mouse.wheel) — mouse.wheel scrolls whatever is
    // under the cursor, and on the results page that's often the embedded map,
    // which eats the scroll as a zoom/pan instead of moving the page.
    console.log("scrolling to load all listing cards ...");
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await sleep(500);
    }
    await sleep(1000);

    console.log("scraping all listings on the page ...");
    const listings = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('a[href*="/rooms/"]'))
        .map((a) => a.closest('[itemprop="itemListElement"]') || a.parentElement?.parentElement || a)
        .filter(Boolean);

      const seen = new Set();
      const unique = [];
      for (const card of cards) {
        const link = card.querySelector('a[href*="/rooms/"]');
        const idMatch = link?.getAttribute("href")?.match(/\/rooms\/(\d+)/);
        const id = idMatch ? idMatch[1] : null;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        unique.push(card);
      }

      return unique.map((card) => {
        const txt = card.innerText || "";
        const link = card.querySelector('a[href*="/rooms/"]');
        const name =
          link?.getAttribute("aria-label") ||
          card.querySelector('[data-testid="listing-card-title"]')?.textContent?.trim() ||
          txt.split("\n")[0] ||
          null;
        const priceMatch = txt.match(/[¥$€£][\d,]+(?:\s*[^\n]*?(?:night|nights))?/i);
        const ratingMatch = txt.match(/([\d.]+)\s*\(\s*(\d+)\s*\)/);
        return {
          name: name ? name.replace(/\s+/g, " ").trim() : null,
          price: priceMatch ? priceMatch[0].replace(/\s+/g, " ").trim() : null,
          priceValue: priceMatch ? parseInt(priceMatch[0].replace(/[^\d]/g, ""), 10) : null,
          rating: ratingMatch ? `${ratingMatch[1]} (${ratingMatch[2]} reviews)` : null,
          ratingValue: ratingMatch ? parseFloat(ratingMatch[1]) : null,
        };
      });
    });
    return listings;
  }

  // scrape page 1
  const page1Listings = await scrapeCurrentPage();
  console.log(`Page 1: ${page1Listings.length} listings`);

  // try to go to page 2.
  // NOTE: getByRole("button", {name: /next/i}) is too broad -- it also
  // matches "Next photo" carousel buttons inside listing cards. Scope to the
  // actual pagination nav and require an exact "Next" label.
  console.log("looking for next page button ...");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(1000);
  const paginationNav = page.locator('nav[aria-label*="Search results" i], nav[aria-label*="pagination" i]').first();
  const nextBtn = (await paginationNav.count() > 0)
    ? paginationNav.getByRole("button", { name: "Next", exact: true }).first()
    : page.getByRole("button", { name: "Next", exact: true }).first();
  let page2Listings = [];
  if (await nextBtn.count() > 0 && await nextBtn.isEnabled()) {
    console.log("clicking next page ...");
    await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(500);
    await nextBtn.click({ timeout: 8000 }).catch((e) => console.log("next page click failed:", e.message));
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(2500);
    page2Listings = await scrapeCurrentPage();
    console.log(`Page 2: ${page2Listings.length} listings`);
  } else {
    console.log("no next page available.");
    await page.screenshot({ path: "/tmp/no_next_page_debug.png" });
    const debugInfo = await page.evaluate(() => {
      const navs = Array.from(document.querySelectorAll("nav")).map((n) => ({
        ariaLabel: n.getAttribute("aria-label"),
        buttons: Array.from(n.querySelectorAll("button, a")).map((b) => ({
          text: (b.textContent || "").trim().slice(0, 20),
          ariaLabel: b.getAttribute("aria-label"),
        })),
      }));
      return navs;
    });
    console.log("all <nav> elements on page:", JSON.stringify(debugInfo, null, 2));
  }

  const allListings = [...page1Listings, ...page2Listings];
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

  await sleep(30000);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
