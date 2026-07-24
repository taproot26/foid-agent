const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const page = await browser.newPage();
  await page.goto("https://www.airbnb.com");

  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/tmp/airbnb_debug_0_initial.png" });

  try {
    await page.getByRole("button", { name: "Close" }).click({ timeout: 5000 });
    console.log("closed promo modal");
  } catch (e) {
    console.log("no close button found:", e.message);
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/airbnb_debug_0b_after_close.png" });

  const whereField = page.getByPlaceholder("Search destinations");
  await whereField.click();
  await whereField.type("Kyoto", { delay: 120 });
  await page.waitForTimeout(1500);

  // dump any role=option elements anywhere on the page
  const options = await page.locator('[role="option"]').all();
  console.log(`found ${options.length} role=option elements`);
  for (const opt of options.slice(0, 5)) {
    const text = await opt.textContent().catch(() => "");
    const id = await opt.getAttribute("id").catch(() => null);
    console.log("OPTION:", { id, text: text?.slice(0, 80) });
  }

  await page.screenshot({ path: "/tmp/airbnb_debug_1_suggestions.png" });

  // click first option if any
  if (options.length > 0) {
    await options[0].click();
  }
  await page.waitForTimeout(1000);

  // find "when"/date trigger — look at buttons, not just text nodes
  const buttons = await page.locator('button').all();
  console.log(`found ${buttons.length} total buttons`);
  for (const btn of buttons) {
    const text = await btn.textContent().catch(() => "");
    if (text && /when|add dates|check.?in/i.test(text)) {
      console.log("WHEN BUTTON CANDIDATE:", text?.slice(0, 60));
    }
  }

  // the widget collapsed back to a pill after selecting the destination.
  // re-open it by clicking the "Where" pill, then click the "When" tab inside.
  try {
    await page.getByText("Kyoto", { exact: true }).first().click({ timeout: 3000 });
    console.log("re-opened widget by clicking Where pill");
  } catch (e) {
    console.log("could not click Where pill:", e.message);
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/airbnb_debug_1b_reopened.png" });

  try {
    const whenText = page.getByText("Add dates", { exact: true }).first();
    const box = await whenText.boundingBox();
    console.log("Add dates bounding box:", box);
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      console.log("clicked at coordinates");
    }
  } catch (e) {
    console.log("coordinate click failed:", e.message);
  }
  await page.waitForTimeout(1200);

  await page.screenshot({ path: "/tmp/airbnb_debug_2_calendar.png" });

  // dump calendar day buttons/testids
  const dayEls = await page.locator('[data-testid^="calendar-day"]').all();
  console.log(`found ${dayEls.length} calendar-day elements`);
  for (const el of dayEls.slice(0, 5)) {
    const testId = await el.getAttribute("data-testid").catch(() => null);
    console.log("DAY:", testId);
  }

  console.log("staying open 20s for manual inspection...");
  await page.waitForTimeout(20000);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
