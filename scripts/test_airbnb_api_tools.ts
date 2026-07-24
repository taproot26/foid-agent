// Direct test of the new airbnb_api_* tools (no LLM in the loop) -- mirrors how
// scripts/test_airbnb_api.js verified the underlying searchAirbnb() function before
// it got wired into the tool registry.
import { airbnbApiSearch, airbnbApiNextPage, airbnbApiGetStats } from "../tools/airbnb_api_tools";

async function main() {
  console.log("--- airbnb_api_search ---");
  const page1 = await airbnbApiSearch({ city: "Bangkok", checkin: "2026-09-03", checkout: "2026-09-10" });
  console.log(page1);

  const page1Parsed = JSON.parse(page1);
  if (page1Parsed.hasNextPage) {
    console.log("--- airbnb_api_next_page ---");
    const page2 = await airbnbApiNextPage({});
    console.log(page2);
  }

  console.log("--- airbnb_api_get_stats ---");
  const stats = await airbnbApiGetStats({});
  console.log(stats);
}

main().catch((e) => console.error("ERROR:", e));
