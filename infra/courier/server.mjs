// Mock courier service. Labeled mock in the UI. State lives in a JSON file
// so bookings survive restarts and Zetaris reads the same state over HTTP.
import { createServer } from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";

const DATA = process.env.COURIER_DATA ?? "/data/slots.json";
const PORT = Number(process.env.PORT ?? 8080);

// Every slot keeps exactly the fields and order Zetaris saw when the table was registered.
// Zetaris maps REST JSON by position, so any extra or reordered field shifts every column.
// Which transfer owns a booking is kept in a separate file Zetaris never reads.
const FIELDS = ["slot_id", "from_site", "to_site", "departs_at", "arrives_at", "status", "booking_id"];
const OWNERS = process.env.COURIER_OWNERS ?? "/data/owners.json";

async function loadOwners() {
  try {
    return JSON.parse(await readFile(OWNERS, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function saveOwners(owners) {
  await writeFile(`${OWNERS}.tmp`, JSON.stringify(owners, null, 2));
  await rename(`${OWNERS}.tmp`, OWNERS);
}

function normalize(slot) {
  return Object.fromEntries(FIELDS.map((f) => [f, slot?.[f] == null ? "" : String(slot[f])]));
}

async function load() {
  try {
    return JSON.parse(await readFile(DATA, "utf8")).map(normalize);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function save(slots) {
  const tmp = `${DATA}.tmp`;
  await writeFile(tmp, JSON.stringify(slots.map(normalize), null, 2));
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

// Requests are handled one at a time, so two bookings can't both take the same slot
let queue = Promise.resolve();
function serial(fn) {
  const next = queue.then(fn);
  queue = next.catch(() => undefined);
  return next;
}

// Books an open slot for a transfer. Repeating the call for the same transfer returns
// the same booking, so a retried or double-clicked accept never books twice.
async function book(body) {
  const slotId = String(body?.slot_id ?? "");
  const transferId = String(body?.transfer_id ?? "");
  if (!slotId || !transferId) return [400, { error: "slot_id and transfer_id are required" }];
  const [slots, owners] = await Promise.all([load(), loadOwners()]);
  const slot = slots.find((s) => s.slot_id === slotId);
  if (!slot) return [404, { error: `No slot ${slotId}` }];
  if (slot.status === "booked" && owners[slot.booking_id] === transferId) return [200, slot];
  if (slot.status !== "open") return [409, { error: `Slot ${slotId} is ${slot.status}` }];
  slot.status = "booked";
  slot.booking_id = `BK-${slotId}-${Date.now().toString(36).toUpperCase()}`;
  owners[slot.booking_id] = transferId;
  await saveOwners(owners);
  await save(slots);
  return [201, slot];
}

async function cancel(bookingId) {
  const [slots, owners] = await Promise.all([load(), loadOwners()]);
  const slot = slots.find((s) => s.booking_id === bookingId);
  if (!slot) return [404, { error: `No booking ${bookingId}` }];
  slot.status = "open";
  slot.booking_id = "";
  delete owners[bookingId];
  await save(slots);
  await saveOwners(owners);
  return [200, slot];
}

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/bookings") {
      const body = await readBody(req);
      const [status, out] = await serial(() => book(body));
      return send(res, status, out);
    }
    const cancelMatch = req.url?.match(/^\/bookings\/([\w-]+)$/);
    if (req.method === "DELETE" && cancelMatch) {
      const [status, out] = await serial(() => cancel(cancelMatch[1]));
      return send(res, status, out);
    }
    if (req.method === "GET" && req.url === "/slots") return send(res, 200, await load());
    if (req.method === "PUT" && req.url === "/slots") {
      const slots = await readBody(req);
      if (!Array.isArray(slots)) return send(res, 400, { error: "expected an array of slots" });
      await serial(() => save(slots));
      return send(res, 200, { count: slots.length });
    }
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
}).listen(PORT, () => console.log(`courier mock listening on ${PORT}`));
