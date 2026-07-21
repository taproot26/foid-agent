import { chromium } from "playwright";
import { loadProfile } from "../profile";

export async function lumaRegister(params: Record<string, any>): Promise<string> {
  const url: string = params.url;
  if (!url) return "missing url param";

  const profile = loadProfile();
  const name = params.name || profile.name;
  const email = params.email || profile.email;
  if (!name || !email) return "no name/email available in params or profile";

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

    const openBtn = page
      .locator('button:has-text("Register"), button:has-text("RSVP"), button:has-text("Request to Join")')
      .first();

    if (!(await openBtn.count())) {
      return "could not find a register/RSVP button on this event page — may need manual signup";
    }

    let emailInput = page.locator('input[name="email"], input[type="email"]').first();
    if (!(await emailInput.count())) {
      // clicking opens a modal with the actual name/email form
      await openBtn.click();
      await page.waitForTimeout(1000);
      emailInput = page.locator('input[name="email"], input[type="email"]').first();
    }

    const nameInput = page.locator('input[name="name"], input[placeholder*="name" i]').first();

    if (await nameInput.count()) await nameInput.fill(name);
    if (await emailInput.count()) await emailInput.fill(email);
    else return "could not find email field after opening registration form";

    const submitBtn = page
      .locator('button:has-text("Register"), button:has-text("RSVP"), button:has-text("Request to Join")')
      .last();

    await submitBtn.click();
    await page.waitForTimeout(2000);

    const confirmed = await page
      .locator('text=/you.?re in|confirmed|see you there|registered/i')
      .first()
      .count();

    return confirmed
      ? `registered ${email} for the event at ${url}`
      : `submitted registration for ${email}, but could not confirm success — check manually`;
  } catch (e: any) {
    return `luma registration failed: ${e.message}`;
  } finally {
    await browser.close();
  }
}
