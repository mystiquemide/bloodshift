import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { loadEnv, optional, required } from "./config.js";
import { ZetarisClient } from "./zetaris.js";
import { readNetworkStock } from "./stock.js";

loadEnv();

const zetaris = new ZetarisClient({
  baseUrl: optional("ZETARIS_BASE_URL", "http://localhost:3000"),
  username: required("ZETARIS_USERNAME"),
  password: required("ZETARIS_PASSWORD"),
  orgId: process.env.ZETARIS_ORG_ID,
});

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function serveStatic(path: string, res: ServerResponse) {
  const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 404, { error: "not found" });
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/stock") {
      return json(res, 200, await readNetworkStock(zetaris));
    }
    if (req.method === "GET") return serveStatic(url.pathname, res);
    json(res, 405, { error: "method not allowed" });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: "Internal error. Check the server log." });
  }
});

const port = Number(optional("PORT", "4000"));
server.listen(port, "127.0.0.1", () => console.log(`Bloodshift on http://localhost:${port}`));
