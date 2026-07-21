import path from "path";
import { lumaRegister } from "./luma_register";

async function main() {
  // defaults to the local mock page — safe, no real registration.
  // pass a real event URL as an argv to test against live Luma (will trigger its bot-check).
  const url = process.argv[2] || `file://${path.join(__dirname, "mock_luma_page.html")}`;
  const result = await lumaRegister({ url });
  console.log("RESULT:", result);
}

main();
