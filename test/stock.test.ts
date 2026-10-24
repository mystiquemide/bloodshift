import { describe, expect, it } from "vitest";
import { isoTime, readNetworkStock, toUnit, type Querier } from "../src/stock.js";
import { SITES } from "../src/sites.js";
import { ZetarisError, type QueryResult } from "../src/zetaris.js";

const siteA = SITES[0]!;

function result(rows: QueryResult["rows"]): QueryResult {
  return { rows, queriedAt: "2026-10-24T17:00:00.000Z", engineMs: 5 };
}

const unitRow = (id: string) => ({
  unit_id: id, site_id: "SITE_A", abo: "O", rh: "+", irradiated: "false",
  expires_at: "2026-10-25 00:00:00.0", status: "available", reserved_for: "",
});

describe("isoTime", () => {
  it("reads zone-less Zetaris timestamps as UTC", () => {
    expect(isoTime("2026-10-25 00:00:00.0")).toBe("2026-10-25T00:00:00.000Z");
  });
  it("keeps an explicit zone", () => {
    expect(isoTime("2026-10-25T01:00:00+01:00")).toBe("2026-10-25T00:00:00.000Z");
  });
  it("rejects garbage instead of inventing a time", () => {
    expect(() => isoTime("soon")).toThrow(/Unreadable timestamp/);
  });
});

describe("toUnit", () => {
  it("normalises CSV-style booleans and empty reservations, and labels the source", () => {
    const u = toUnit({ ...unitRow("U-A-0001"), irradiated: "true" }, siteA);
    expect(u.irradiated).toBe(true);
    expect(u.reservedFor).toBeNull();
    expect(u.source).toContain("bs_site_a.platelet_units");
  });
  it("rejects a row with no unit ID", () => {
    expect(() => toUnit({ ...unitRow(""), unit_id: null }, siteA)).toThrow(/without unit_id/);
  });
});

describe("readNetworkStock", () => {
  it("is loaded when every source answers", async () => {
    const z: Querier = { query: async (sql) => result(sql.includes("slots") ? [] : [unitRow("U-1")]) };
    const stock = await readNetworkStock(z);
    expect(stock.state).toBe("loaded");
    expect(stock.sites.every((s) => s.units.length === 1)).toBe(true);
  });

  it("is partial and names the failed site when one source is down", async () => {
    const z: Querier = {
      query: async (sql) => {
        if (sql.includes("bs_site_b")) throw new ZetarisError("HiveSQLException: at org.apache...", "query", 500);
        return result(sql.includes("slots") ? [] : [unitRow("U-1")]);
      },
    };
    const stock = await readNetworkStock(z);
    expect(stock.state).toBe("partial");
    const b = stock.sites.find((s) => s.site.id === "SITE_B")!;
    expect(b.status).toEqual({ ok: false, error: "Zetaris couldn't read Postgres (Site B LIS). The source may be offline." });
    expect(JSON.stringify(b.status)).not.toContain("org.apache");
    expect(b.units).toEqual([]);
    expect(stock.sites.filter((s) => s.status.ok)).toHaveLength(2);
  });

  it("is error when nothing answers, and shows no cached rows", async () => {
    const z: Querier = { query: async () => { throw new Error("Zetaris down"); } };
    const stock = await readNetworkStock(z);
    expect(stock.state).toBe("error");
    expect(stock.sites.flatMap((s) => s.units)).toEqual([]);
  });
});
