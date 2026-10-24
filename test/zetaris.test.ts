import { describe, expect, it } from "vitest";
import { ZetarisClient, ZetarisError } from "../src/zetaris.js";

type Handler = (path: string, init: RequestInit) => Response;

function client(handler: Handler, calls: string[] = []) {
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    return handler(path, init ?? {});
  }) as typeof fetch;
  return new ZetarisClient({ baseUrl: "http://z.test", username: "u", password: "p", fetchImpl });
}

const login = () => Response.json({ idToken: "tok", orgId: 7 });

describe("ZetarisClient", () => {
  it("logs in once and maps headers onto rows", async () => {
    const calls: string[] = [];
    let auth = "";
    const z = client((path, init) => {
      if (path === "/api/auth/login") return login();
      const h = init.headers as Record<string, string>;
      auth = `${h.Authorization} org=${h["X-Org-ID"]}`;
      return Response.json({ headers: ["a", "b"], data: [[1, "x"]], timeUsed: 12 });
    }, calls);
    const r1 = await z.query("SELECT 1");
    await z.query("SELECT 2");
    expect(r1.rows).toEqual([{ a: 1, b: "x" }]);
    expect(r1.engineMs).toBe(12);
    expect(auth).toBe("Bearer tok org=7");
    expect(calls.filter((c) => c === "/api/auth/login")).toHaveLength(1);
  });

  it("logs in again once when the session expires", async () => {
    let queries = 0;
    const calls: string[] = [];
    const z = client((path) => {
      if (path === "/api/auth/login") return login();
      queries++;
      return queries === 2 ? new Response("expired", { status: 401 }) : Response.json({ headers: [], data: [] });
    }, calls);
    await z.query("SELECT 1");
    await expect(z.query("SELECT 2")).resolves.toMatchObject({ rows: [] });
    expect(calls.filter((c) => c === "/api/auth/login")).toHaveLength(2);
  });

  it("surfaces a query error with the engine's message", async () => {
    const z = client((path) => (path === "/api/auth/login" ? login() : Response.json({ msg: "table not found" }, { status: 500 })));
    await expect(z.query("SELECT x")).rejects.toMatchObject({ kind: "query", message: expect.stringContaining("table not found") });
  });

  it("reports an unreachable Zetaris instead of hanging or returning data", async () => {
    const z = new ZetarisClient({
      baseUrl: "http://z.test", username: "u", password: "p",
      fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
    });
    const err = await z.query("SELECT 1").catch((e) => e);
    expect(err).toBeInstanceOf(ZetarisError);
    expect(err.kind).toBe("unreachable");
  });

  it("rejects a malformed result", async () => {
    const z = client((path) => (path === "/api/auth/login" ? login() : Response.json({ rows: "nope" })));
    await expect(z.query("SELECT 1")).rejects.toThrow(/unexpected result shape/);
  });
});
