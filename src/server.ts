import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { loadEnv, optional, required } from "./config.js";
import { ZetarisClient } from "./zetaris.js";
import { readNetworkStock } from "./stock.js";
import { TransferStore } from "./transfers.js";
import { PlanAborted, replan, runPlan, sendProposals, type PlannerDeps } from "./planner.js";
import { NemotronDecider, templateDecider, type Decider } from "./nemotron.js";
import { DeclineMemory } from "./declineMemory.js";
import { declineTransfer } from "./decline.js";
import { AcceptError, acceptTransfer } from "./accept.js";
import { CourierClient } from "./courier.js";
import { siteWritersFromEnv } from "./siteWriters.js";
import { SITES, type SiteId } from "./sites.js";
import type { IncomingMessage } from "node:http";
import { compare, DEFAULT_SITES } from "./simulation.js";

loadEnv();

const zetaris = new ZetarisClient({
  baseUrl: optional("ZETARIS_BASE_URL", "http://localhost:3000"),
  username: required("ZETARIS_USERNAME"),
  password: required("ZETARIS_PASSWORD"),
  orgId: process.env.ZETARIS_ORG_ID,
});

// Refuses to start if the World Model log can't be replayed
const store = await TransferStore.open({ directory: optional("WORLD_DIR", "data") });
const memory = await DeclineMemory.open({ directory: optional("WORLD_DIR", "data") });
const decider: Decider = process.env.NVIDIA_API_KEY
  ? new NemotronDecider({
      apiKey: process.env.NVIDIA_API_KEY,
      model: optional("NEMOTRON_MODEL", "nvidia/nemotron-3.5-super-vl-120b-a12b"),
      thinking: optional("NEMOTRON_THINKING", "off") === "on",
    })
  : templateDecider;
const planner: PlannerDeps = { zetaris, store, decider, memory };
console.log(`Requests and replans by ${decider.name === "nemotron" ? `Nemotron (${optional("NEMOTRON_MODEL", "nvidia/nemotron-3.5-super-vl-120b-a12b")})` : "the standard template"}`);
let planInFlight = false;

// The simulation is deterministic, so it's computed once on first request.
// It runs on synthetic data and never touches live sources or the live view.
let simulation: unknown = null;
function simulationSummary(): unknown {
  if (simulation) return simulation;
  const seeds = Array.from({ length: 20 }, (_, i) => 1000 + i);
  const s = compare(seeds);
  const byGroup = (policy: "noSharing" | "rule") => {
    const out: Record<string, number> = {};
    for (const run of s.perSeed) for (const [g, n] of Object.entries(run[policy].outdatesByGroup)) out[g] = (out[g] ?? 0) + n / s.perSeed.length;
    return out;
  };
  simulation = {
    runs: s.runs, days: s.days, sites: DEFAULT_SITES,
    noSharing: s.noSharing, rule: s.rule,
    outdateReduction: s.outdateReduction, outdateReductionRange: s.outdateReductionRange,
    outdatesByGroup: { noSharing: byGroup("noSharing"), rule: byGroup("rule") },
  };
  return simulation;
}
const writers = siteWritersFromEnv();
const courier = new CourierClient(`http://127.0.0.1:${optional("COURIER_PORT", "8090")}`);

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new AcceptError("Request body too large", 400);
  }
  try {
    const body = raw ? JSON.parse(raw) : {};
    return body && typeof body === "object" ? body : {};
  } catch {
    throw new AcceptError("Request body isn't valid JSON", 400);
  }
}

function siteFrom(body: Record<string, unknown>): SiteId {
  const site = body.site;
  if (typeof site !== "string" || !SITES.some((s) => s.id === site)) throw new AcceptError("Unknown site", 400);
  return site as SiteId;
}

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

// Clean paths for the pages. The .html paths keep working.
const PAGES: Record<string, string> = {
  "/app": "/app.html",
  "/how-it-works": "/how-it-works.html",
  "/simulation": "/simulation.html",
};
// The landing page takes over / in the next step. Until then / opens the app.
const REDIRECTS: Record<string, string> = {
  "/": "/app",
  "/index.html": "/app",
  "/app.html": "/app",
};

async function serveStatic(path: string, res: ServerResponse) {
  const rel = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return notFound(res);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    notFound(res);
  }
}

async function notFound(res: ServerResponse) {
  try {
    res.writeHead(404, { "Content-Type": TYPES[".html"]! });
    res.end(await readFile(join(PUBLIC_DIR, "404.html")));
  } catch {
    json(res, 404, { error: "not found" });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  // State-changing calls must carry a custom header. A cross-site form or fetch can't add one
  // without a CORS preflight, which this server never approves.
  if (req.method === "POST" && req.headers["x-bloodshift"] !== "1") {
    return json(res, 403, { error: "Missing request header" });
  }
  try {
    if (req.method === "GET" && url.pathname === "/api/stock") {
      return json(res, 200, await readNetworkStock(zetaris));
    }
    if (req.method === "GET" && url.pathname === "/api/transfers") {
      return json(res, 200, { transfers: store.list() });
    }
    const history = url.pathname.match(/^\/api\/transfers\/([\w-]+)\/history$/);
    if (req.method === "GET" && history) {
      const t = store.get(history[1]!);
      return t ? json(res, 200, { transfer: t, history: store.history(t.id) }) : json(res, 404, { error: "No such transfer" });
    }
    if (req.method === "POST" && url.pathname === "/api/plan") {
      if (planInFlight) return json(res, 409, { error: "A plan is already running." });
      planInFlight = true;
      try {
        return json(res, 200, await runPlan(planner));
      } catch (err) {
        if (err instanceof PlanAborted) return json(res, 503, { error: err.message });
        throw err;
      } finally {
        planInFlight = false;
      }
    }
    const accept = url.pathname.match(/^\/api\/transfers\/([\w-]+)\/(accept|retry)$/);
    if (req.method === "POST" && accept) {
      const site = siteFrom(await readJson(req));
      const transfer = await acceptTransfer({ zetaris, store, writers, courier }, accept[1]!, site);
      // A refused unit is gone at its source. Offer the receiving site another one.
      if (transfer.state === "refused") return json(res, 200, { transfer, replan: await replan(planner, transfer.id) });
      return json(res, 200, { transfer });
    }
    const decline = url.pathname.match(/^\/api\/transfers\/([\w-]+)\/decline$/);
    if (req.method === "POST" && decline) {
      const body = await readJson(req);
      return json(res, 200, await declineTransfer(planner, decline[1]!, siteFrom(body), body.reason));
    }
    if (req.method === "GET" && url.pathname === "/api/simulation") {
      return json(res, 200, simulationSummary());
    }
    if (req.method === "GET" && url.pathname === "/api/declines") {
      const site = url.searchParams.get("site");
      if (site && !SITES.some((s) => s.id === site)) return json(res, 400, { error: "Unknown site" });
      return json(res, 200, { declines: site ? memory.forSite(site as SiteId, 50) : memory.all() });
    }
    if (req.method === "POST" && url.pathname === "/api/transfers/send") {
      return json(res, 200, { sent: await sendProposals(store, "coordinator") });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
    if (req.method === "GET") {
      const to = REDIRECTS[url.pathname];
      if (to) {
        // Keep ?view= so old inbox links still land on the right lab
        res.writeHead(url.pathname === "/" ? 302 : 301, { Location: to + url.search });
        return res.end();
      }
      return serveStatic(PAGES[url.pathname] ?? url.pathname, res);
    }
    json(res, 405, { error: "method not allowed" });
  } catch (err) {
    if (err instanceof AcceptError) return json(res, err.status, { error: err.message });
    console.error(err);
    json(res, 500, { error: "Internal error. Check the server log." });
  }
});

const port = Number(optional("PORT", "4000"));
// Loopback by default. Behind a reverse proxy in another container, set HOST so the proxy can reach it.
const host = optional("HOST", "127.0.0.1");
server.listen(port, host, () => console.log(`Bloodshift on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`));
