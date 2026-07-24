// Each function is one discrete step of the Airbnb flow. Every step DOES ONE
// THING and returns { ok, ...state } describing what actually happened, so a
// caller (deterministic driver today, an LLM agent later) can check the
// result before deciding whether to proceed, retry, or abort.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function closeAnyModal(page, label) {
  const modal = page.locator('[data-testid="modal-container"]');
  if (await modal.count() === 0) return { ok: true, closed: false };
  console.log(`  modal detected${label ? " (" + label + ")" : ""}, closing ...`);
  const closeBtn = page.getByRole("button", { name: "Close" }).first();
  if (await closeBtn.count() > 0) {
    await closeBtn.click({ force: true }).catch(() => {});
  } else {
    await page.keyboard.press("Escape").catch(() => {});
  }
  await sleep(600);
  return { ok: true, closed: true };
}

async function gotoAirbnb(page) {
  await page.goto("https://www.airbnb.com");
  await sleep(1500);
  await closeAnyModal(page, "initial load");
  const loaded = await page.getByPlaceholder("Search destinations").count() > 0;
  return { ok: loaded, step: "gotoAirbnb", loaded };
}

async function searchDestination(page, city) {
  console.log(`typing ${city} into Where field ...`);
  const whereField = page.getByPlaceholder("Search destinations");
  await whereField.click();
  await whereField.type(city, { delay: 120 });
  await sleep(1500);
  await closeAnyModal(page, "after typing city");

  console.log("selecting first suggestion ...");
  let suggestionPicked = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const opt = page.locator('[role="option"]').first();
    if (await opt.count() > 0) {
      await sleep(800);
      await opt.click({ force: true }).catch((e) => {
        console.log(`  suggestion click attempt ${attempt + 1} failed:`, e.message);
      });
      await sleep(800);
      suggestionPicked = true;
      break;
    }
    console.log("  suggestion not visible yet, waiting ...");
    await sleep(500);
  }
  await closeAnyModal(page, "after selecting suggestion");

  // verify: the Where field should now show the city, not just "Where".
  // Return only a compact confirmation string (NOT the raw page dump) -- an
  // earlier version returned the whole page text here and the small model
  // re-called this tool repeatedly, timing out, because it couldn't tell it
  // had succeeded. A clean {ok:true, confirmedDestination:"Phuket"} stops that.
  const whereText = await page.locator('div:has-text("Where")').first().innerText().catch(() => "");
  const cityWord = city.toLowerCase().split(",")[0];
  const destinationConfirmed = suggestionPicked && whereText.toLowerCase().includes(cityWord);

  return {
    ok: destinationConfirmed,
    step: "searchDestination",
    confirmedDestination: destinationConfirmed ? city : null,
  };
}

async function openCalendar(page) {
  console.log("clicking Add dates to open the calendar ...");
  let calendarOpen = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    await closeAnyModal(page, `before Add dates attempt ${attempt + 1}`);
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
    await page.screenshot({ path: "/tmp/calendar_never_opened.png" }).catch(() => {});
  }
  await sleep(1500);
  return { ok: calendarOpen, step: "openCalendar", calendarOpen };
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// Read the month/year headers currently rendered in the calendar, e.g.
// [{month:"July", year:2026, idx:24306}, {month:"August", year:2026, idx:24307}].
// idx = year*12 + monthIndex, a single comparable number for "how far in time".
async function readVisibleMonths(page) {
  const texts = await page.evaluate(() => {
    const names = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const out = [];
    // Airbnb renders each month header as text like "September 2026" somewhere in the calendar.
    for (const el of Array.from(document.querySelectorAll("h2, div, span, caption"))) {
      const t = (el.textContent || "").trim();
      const m = t.match(/^([A-Z][a-z]+)\s+(\d{4})$/);
      if (m && names.includes(m[1])) out.push(`${m[1]} ${m[2]}`);
    }
    return Array.from(new Set(out));
  }).catch(() => []);
  return texts.map((t) => {
    const [month, year] = t.split(" ");
    return { month, year: parseInt(year, 10), idx: parseInt(year, 10) * 12 + MONTH_NAMES.indexOf(month) };
  });
}

async function clickDay(page, dayNumber, label, monthName) {
  console.log(`looking for day "${dayNumber}" (${label}) in ${monthName} ...`);

  // The LLM frequently supplies the WRONG YEAR (its training cutoff makes it
  // default to 2023). The calendar physically cannot show past months, so we
  // ignore the model's year entirely: match on the MONTH NAME and take the
  // soonest visible-or-future occurrence. We read the actual visible headers
  // each iteration and navigate toward the target instead of blindly clicking
  // "next" a fixed number of times.
  const targetMonthWord = monthName.split(" ")[0];
  const targetMonthIndex = MONTH_NAMES.indexOf(targetMonthWord);
  if (targetMonthIndex === -1) {
    return { ok: false, step: "clickDay", error: `unrecognized month "${targetMonthWord}"`, dayNumber, label };
  }

  let resolvedYear = null;
  let monthFound = false;
  for (let advance = 0; advance < 14; advance++) {
    const visible = await readVisibleMonths(page);
    const visibleStr = visible.map((v) => `${v.month} ${v.year}`).join(", ");
    console.log(`  visible months: [${visibleStr}]`);

    // is the target month name one of the visible headers?
    const match = visible.find((v) => v.month === targetMonthWord);
    if (match) {
      resolvedYear = match.year;
      monthFound = true;
      console.log(`  ✓ ${targetMonthWord} ${resolvedYear} is visible.`);
      break;
    }

    // decide direction from the visible headers: if the target month sits
    // AFTER the latest visible month (in the soonest-future sense), go forward.
    // If it's somehow before the earliest visible month, it's in the past and
    // unreachable in a search calendar -- fail fast instead of spinning.
    if (!visible.length) {
      console.log("  (no month headers read yet, waiting)");
      await sleep(600);
      continue;
    }
    const latest = visible[visible.length - 1];
    const earliest = visible[0];
    // soonest future idx of the target month relative to the earliest visible month
    let targetIdx = earliest.year * 12 + targetMonthIndex;
    if (targetIdx < earliest.idx) targetIdx += 12; // wrap to next year

    if (targetIdx <= latest.idx) {
      // target should already be on screen but we didn't match -- treat as not found
      console.log(`  ✗ ${targetMonthWord} appears to be in the past / before the calendar window.`);
      break;
    }

    console.log(`  ${targetMonthWord} not visible yet (attempt ${advance + 1}), clicking next month ...`);
    const nextBtn = page.getByRole("button", { name: /next month/i }).first();
    if (await nextBtn.count() === 0) {
      console.log("  ✗ Could not find next-month button.");
      break;
    }
    await nextBtn.click().catch(() => {});
    await sleep(900);
  }

  if (!monthFound) {
    await page.screenshot({ path: "/tmp/month_not_found.png" }).catch(() => {});
    return { ok: false, step: "clickDay", monthFound: false, dayNumber, label };
  }

  // Airbnb's calendar day buttons carry the full date in their aria-label
  // (e.g. "3, Thursday, September 2026. Available."), so match on month word +
  // the YEAR WE ACTUALLY RESOLVED from the visible header (not the model's guess).
  const monthWord = targetMonthWord;
  const yearWord = String(resolvedYear);

  const candidates = page.locator("button", { hasText: new RegExp(`^${dayNumber}$`) });
  const count = await candidates.count();
  console.log(`  found ${count} candidate button(s) total on the page`);
  for (let i = 0; i < count; i++) {
    const btn = candidates.nth(i);
    const disabled = await btn.getAttribute("aria-disabled");
    const visible = await btn.isVisible().catch(() => false);
    const ariaLabel = (await btn.getAttribute("aria-label").catch(() => "")) || "";
    const inRightMonth = ariaLabel.includes(monthWord) && ariaLabel.includes(yearWord);
    console.log(`  candidate ${i}: disabled=${disabled}, visible=${visible}, ariaLabel="${ariaLabel}", inRightMonth=${inRightMonth}`);
    if (disabled !== "true" && visible && inRightMonth) {
      await btn.scrollIntoViewIfNeeded();
      await sleep(600);
      await btn.hover();
      console.log(`  hovering over ${label} for 1.5s before clicking ...`);
      await sleep(1500);
      await btn.click();
      console.log(`  clicked ${label}.`);
      return { ok: true, step: "clickDay", clicked: true, dayNumber, label };
    }
  }
  console.log(`  no enabled/visible candidate found for ${label}.`);
  return { ok: false, step: "clickDay", clicked: false, dayNumber, label };
}

async function selectDates(page, checkInDay, checkOutDay, monthName) {
  const checkInResult = await clickDay(page, checkInDay, `check-in (day ${checkInDay})`, monthName);
  if (!checkInResult.ok) return { ok: false, step: "selectDates", failedAt: "checkIn", checkInResult };

  console.log("pausing 2.5s between check-in and check-out clicks ...");
  await sleep(2500);

  const checkOutResult = await clickDay(page, checkOutDay, `check-out (day ${checkOutDay})`, monthName);
  if (!checkOutResult.ok) return { ok: false, step: "selectDates", failedAt: "checkOut", checkOutResult };

  console.log("pausing 2.5s after selecting both dates ...");
  await sleep(2500);

  // hard check: the "When" field must no longer show placeholder text.
  // Extract just the compact date range (e.g. "Sep 3 - 10") for the model,
  // not the whole page dump.
  const whenText = await page.locator('div:has-text("When")').first().innerText().catch(() => "");
  console.log("When field now shows:", JSON.stringify(whenText.slice(0, 200)));
  const stillPlaceholder = whenText.includes("Add dates") || whenText.includes("Check in") || whenText.includes("Check out");
  const rangeMatch = whenText.match(/[A-Z][a-z]{2}\s+\d{1,2}\s*[-–]\s*(?:[A-Z][a-z]{2}\s+)?\d{1,2}/);

  return {
    ok: !stillPlaceholder,
    step: "selectDates",
    confirmedDates: rangeMatch ? rangeMatch[0] : null,
    stillPlaceholder,
  };
}

async function clickSearch(page) {
  console.log("clicking Search.");
  await page.getByRole("button", { name: "Search" }).first().click({ timeout: 5000 }).catch((e) =>
    console.log("search click failed:", e.message)
  );
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(2500);
  await closeAnyModal(page, "results page");

  // verify: URL should now reflect a search (contains /s/ path)
  const onResultsPage = page.url().includes("/s/");
  return { ok: onResultsPage, step: "clickSearch", url: page.url() };
}

async function scrapeCurrentPage(page) {
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

  return { ok: listings.length > 0, step: "scrapeCurrentPage", listings };
}

async function goToNextPage(page, targetPageNumber) {
  // Airbnb's pagination is a row of NUMBERED links/buttons (1, 2, 3, ... , >),
  // not a labeled "Next" control -- so target the specific number instead.
  console.log(`looking for page ${targetPageNumber} button ...`);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(1000);
  const paginationNav = page.locator('nav[aria-label*="Search results" i], nav[aria-label*="pagination" i]').first();
  const scope = (await paginationNav.count() > 0) ? paginationNav : page;
  // the page-number control can render as either a <button> or an <a> link,
  // so match on role "link" too, not just "button".
  const pageLink = scope.getByRole("link", { name: String(targetPageNumber), exact: true }).first();
  const pageButton = scope.getByRole("button", { name: String(targetPageNumber), exact: true }).first();
  const pageBtn = (await pageLink.count() > 0) ? pageLink : pageButton;

  if (await pageBtn.count() === 0) {
    console.log(`no page ${targetPageNumber} button/link found.`);
    const debugInfo = await page.evaluate(() => {
      const navs = Array.from(document.querySelectorAll("nav")).map((n) => ({
        ariaLabel: n.getAttribute("aria-label"),
        items: Array.from(n.querySelectorAll("button, a")).map((b) => ({
          tag: b.tagName,
          text: (b.textContent || "").trim().slice(0, 20),
          ariaLabel: b.getAttribute("aria-label"),
          ariaCurrent: b.getAttribute("aria-current"),
        })),
      }));
      return navs;
    });
    console.log("DEBUG nav elements:", JSON.stringify(debugInfo, null, 2));
    return { ok: false, step: "goToNextPage", hasNext: false };
  }

  console.log(`clicking page ${targetPageNumber} ...`);
  await pageBtn.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(500);
  await pageBtn.click({ timeout: 8000 }).catch((e) => console.log("page click failed:", e.message));
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(2500);

  return { ok: true, step: "goToNextPage", hasNext: true };
}

module.exports = {
  sleep,
  closeAnyModal,
  gotoAirbnb,
  searchDestination,
  openCalendar,
  clickDay,
  selectDates,
  clickSearch,
  scrapeCurrentPage,
  goToNextPage,
};
