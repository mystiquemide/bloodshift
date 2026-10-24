// Mock courier service. Labeled mock in the UI. State lives in a JSON file
// so bookings survive restarts and Zetaris reads the same state over HTTP.
import { createServer } from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";

const DATA = process.env.COURIER_DATA ?? "/data/slots.json";
const PORT = Number(process.env.PORT ?? 8080);

async function load() {
  try {
    return JSON.parse(await readFile(DATA, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function save(slots) {
  const tmp = `${DATA}.tmp`;
  await writeFile(tmp, JSON.stringify(slots, null, 2));
  await rename(tmp, DATA);
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : null;
}

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/slots") return send(res, 200, await load());
    if (req.method === "PUT" && req.url === "/slots") {
      const slots = await readBody(req);
      if (!Array.isArray(slots)) return send(res, 400, { error: "expected an array of slots" });
      await save(slots);
      return send(res, 200, { count: slots.length });
    }
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
}).listen(PORT, () => console.log(`courier mock listening on ${PORT}`));
