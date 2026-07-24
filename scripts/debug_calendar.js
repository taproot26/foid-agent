const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 120 });
  const page = await browser.newPage();
  await page.goto("https://www.airbnb.com");
  await page.waitForTimeout(1500);

  // close modal
  for (let i = 0; i < 4; i++) {
    const m = page.locator('[data-testid="modal-container"]');
    if (await m.count() === 0) break;
    const c = page.getByRole("button", { name: "Close" }).first();
    if (await c.count() > 0) await c.click({ force: true }).catch(() => {});
    else await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
  }

  // type city + pick suggestion
  const where = page.getByPlaceholder("Search destinations");
  await where.click();
  await where.type("Kyoto", { delay: 100 });
  await page.waitForTimeout(1000);
  await page.locator('[role="option"]').first().click({ timeout: 5000 }).catch((e) => console.log("suggestion click fail:", e.message));
  await page.waitForTimeout(1000);

  console.log("\n=== state after picking suggestion ===");
  await page.screenshot({ path: "/tmp/cal_debug_1.png" });

  // Look for anything clickable containing date-related text
  const dateTriggers = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent || "").trim();
      if (/^(add dates|check.?in|check.?out|when)$/i.test(t) && el.children.length <= 2) {
        out.push({ tag: el.tagName, role: el.getAttribute("role"), testid: el.getAttribute("data-testid"), text: t.slice(0, 30) });
      }
    }
    return out.slice(0, 20);
  });
  console.log("date-trigger candidates:", JSON.stringify(dateTriggers, null, 2));

  // Try clicking "Add dates"
  await page.getByText("Add dates", { exact: true }).first().click({ force: true }).catch((e) => console.log("Add dates click fail:", e.message));
  await page.waitForTimeout(1500);

  console.log("\n=== state after clicking Add dates ===");
  await page.screenshot({ path: "/tmp/cal_debug_2.png" });

  // Dump every data-testid that mentions calendar/day, plus grid/gridcell roles
  const calInfo = await page.evaluate(() => {
    const testids = new Set();
    for (const el of document.querySelectorAll('[data-testid]')) {
      const t = el.getAttribute("data-testid");
      if (/calendar|day|date/i.test(t)) testids.add(t);
    }
    const gridcells = Array.from(document.querySelectorAll('[role="gridcell"], td[role], button[aria-label*="202"]'))
      .slice(0, 10)
      .map((el) => ({
        role: el.getAttribute("role"),
        testid: el.getAttribute("data-testid"),
        ariaLabel: el.getAttribute("aria-label"),
        text: (el.textContent || "").trim().slice(0, 20),
      }));
    return {
      matchingTestids: Array.from(testids).slice(0, 30),
      sampleGridcells: gridcells,
    };
  });
  console.log("calendar-related testids:", JSON.stringify(calInfo.matchingTestids, null, 2));
  console.log("sample gridcells:", JSON.stringify(calInfo.sampleGridcells, null, 2));

  console.log("\nstaying open 25s...");
  await page.waitForTimeout(25000);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
