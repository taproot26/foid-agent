const cheerio = require("cheerio");

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BASE_URL = "https://www.airbnb.com";

function cleanObject(obj) {
  Object.keys(obj).forEach((key) => {
    if (obj[key] == null || key === "__typename") {
      delete obj[key];
    } else if (typeof obj[key] === "object") {
      cleanObject(obj[key]);
    }
  });
}

async function geocodeLocation(location) {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(location)}&limit=5`;
  const res = await fetch(url, { headers: { "User-Agent": "test-script/1.0", Accept: "application/json" } });
  if (!res.ok) return null;
  const data = await res.json();
  const feature = data?.features?.[0];
  if (!feature?.properties?.extent) return null;
  const [west, north, east, south] = feature.properties.extent;
  return { sw_lat: south, ne_lat: north, sw_lng: west, ne_lng: east, displayName: feature.properties.name };
}

async function searchAirbnb(city, checkin, checkout) {
  const slug = city.replace(/,\s*/g, "--").replace(/\s+/g, "-");
  const url = new URL(`${BASE_URL}/s/${encodeURIComponent(slug)}/homes`);
  const coords = await geocodeLocation(city);
  if (coords) {
    url.searchParams.append("ne_lat", coords.ne_lat);
    url.searchParams.append("ne_lng", coords.ne_lng);
    url.searchParams.append("sw_lat", coords.sw_lat);
    url.searchParams.append("sw_lng", coords.sw_lng);
    console.log(`geocoded "${city}" -> ${coords.displayName}`);
  }
  if (checkin) url.searchParams.append("checkin", checkin);
  if (checkout) url.searchParams.append("checkout", checkout);
  url.searchParams.append("adults", "1");

  console.log("fetching:", url.toString());
  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  console.log("status:", res.status);
  const html = await res.text();
  console.log("html length:", html.length);

  const $ = cheerio.load(html);
  const scriptEl = $("#data-deferred-state-0").first();
  console.log("found script tag:", scriptEl.length > 0);
  if (scriptEl.length === 0) {
    require("fs").writeFileSync("/tmp/airbnb_api_debug.html", html);
    console.log("saved raw html to /tmp/airbnb_api_debug.html for inspection");
    return;
  }

  const scriptContent = $(scriptEl).text();
  const clientData = JSON.parse(scriptContent);
  const results = clientData.niobeClientData[0][1].data.presentation.staysSearch.results;
  cleanObject(results);

  console.log("total searchResults:", results.searchResults.length);
  console.log("paginationInfo:", JSON.stringify(results.paginationInfo));

  const sample = results.searchResults.slice(0, 5).map((r) => {
    const id = Buffer.from(r.demandStayListing.id, "base64").toString("utf-8").split(":")[1];
    return {
      id,
      price: r.structuredDisplayPrice?.primaryLine?.accessibilityLabel,
      rating: r.avgRatingA11yLabel,
    };
  });
  console.log("sample listings:", JSON.stringify(sample, null, 2));
}

const city = process.argv[2] || "Phuket, Thailand";
const checkin = process.argv[3] || "2026-10-10";
const checkout = process.argv[4] || "2026-10-25";
searchAirbnb(city, checkin, checkout).catch((e) => console.error("ERROR:", e));
