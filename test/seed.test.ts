import { describe, expect, it } from "vitest";
import { generate } from "../scripts/seed.js";

describe("seed", () => {
  const now = new Date("2026-10-24T17:23:00Z");

  it("is deterministic for a fixed seed", () => {
    expect(generate(42, now)).toEqual(generate(42, now));
  });

  it("gives every unit a unique ID and an expiry 6 to 118 hours out", () => {
    const { units } = generate(42, now);
    expect(new Set(units.map((u) => u.unit_id)).size).toBe(units.length);
    const anchor = Date.parse("2026-10-24T17:00:00Z");
    for (const u of units) {
      const h = (Date.parse(u.expires_at) - anchor) / 3_600_000;
      expect(h).toBeGreaterThanOrEqual(6);
      expect(h).toBeLessThan(118);
    }
  });

  it("builds the imbalance: Site A uses less per unit held than Site B", () => {
    const { units, usage } = generate(42, now);
    const ratio = (site: string) =>
      usage.filter((h) => h.site_id === site).reduce((n, h) => n + h.units_used, 0) / units.filter((u) => u.site_id === site).length;
    expect(ratio("SITE_A")).toBeLessThan(ratio("SITE_B"));
  });
});
