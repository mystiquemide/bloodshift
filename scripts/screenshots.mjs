// Captures the landing page's product images from the running app, so they never drift from the real UI.
// Needs Playwright with Chromium, a running app (npm start) and at least one reserved transfer.
//   node scripts/screenshots.mjs [http://localhost:4000]
import { createRequire } from "node:module";
import { writeFile, mkdir } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = process.argv[2] ?? "http://localhost:4000";
const OUT = new URL("../public/img/", import.meta.url);

// Chromium encodes WebP itself, so no image tool is needed
async function saveWebp(page, png, name) {
  const dataUrl = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/webp", 0.86);
  }, png.toString("base64"));
  if (!dataUrl.startsWith("data:image/webp")) throw new Error("This Chromium can't encode WebP");
  await writeFile(new URL(name, OUT), Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(`Saved public/img/${name}`);
}

const transfers = (await (await fetch(`${BASE}/api/transfers`)).json()).transfers;
if (!transfers.some((t) => t.state === "reserved")) {
  console.error("No reserved transfer yet. Run the morning plan, send it and accept one, then run this again.");
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });

// IMG-1: the coordinator's plan panel with its request bubbles
await page.goto(`${BASE}/app`);
await page.waitForSelector("#transfers .transfer");
const plan = await page.$("#coordinator");
const box = await plan.boundingBox();
const shot1 = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 760) }, fullPage: true });
await saveWebp(page, shot1, "plan.webp");

// IMG-5: the proof drawer of a reserved transfer, showing the three reads and the history
const card = page.locator("#transfers .transfer.state-reserved").first();
await card.locator("details.proof summary").click();
await card.locator(".proof-body .proof-step").first().waitFor();
await card.locator("details.proof").scrollIntoViewIfNeeded();
await saveWebp(page, await card.locator("details.proof").screenshot(), "proof.webp");

await browser.close();
