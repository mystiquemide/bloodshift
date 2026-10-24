import { describe, expect, it } from "vitest";
import {
  assertLiveUnits, buildCandidates, buildPlan, projectSite, rankCandidates,
  type Demand, type PlanInput, type SitePolicy,
} from "../src/rules.js";
import type { SiteId } from "../src/sites.js";
import type { CourierSlot, StockUnit } from "../src/stock.js";

const NOW = new Date("2026-10-24T12:00:00Z");
const h = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

function unit(id: string, site: SiteId, expiresInH: number, extra: Partial<StockUnit> = {}): StockUnit {
  return { unitId: id, siteId: site, abo: "O", rh: "+", irradiated: false, expiresAt: h(expiresInH), status: "available", reservedFor: null, source: "test", ...extra };
}

function slot(id: string, from: SiteId, to: SiteId, departH: number, extra: Partial<CourierSlot> = {}): CourierSlot {
  return { slotId: id, fromSite: from, toSite: to, departsAt: h(departH), arrivesAt: h(departH + 2), status: "open", bookingId: null, ...extra };
}

const policy = (p: Partial<SitePolicy> = {}): SitePolicy => ({ safetyStock: 0, needsIrradiated: false, ...p });

// Site A holds five O+ units and uses 1 a day. Site B uses 10 a day and holds none.
function scenario(over: Partial<PlanInput> = {}): PlanInput {
  const demand: Demand = new Map([["SITE_A|O+", 1], ["SITE_B|O+", 10], ["SITE_C|O+", 0.5]]);
  return {
    now: NOW,
    units: [30, 40, 50, 60, 70].map((e, i) => unit(`U-A-${i}`, "SITE_A", e)),
    demand,
    slots: [slot("S-1", "SITE_A", "SITE_B", 2), slot("S-2", "SITE_A", "SITE_B", 6), slot("S-3", "SITE_A", "SITE_B", 10), slot("S-4", "SITE_A", "SITE_C", 2)],
    policies: { SITE_A: policy(), SITE_B: policy(), SITE_C: policy() },
    transferredUnitIds: new Set(),
    activeUnitIds: new Set(),
    declined: new Map(),
    ...over,
  };
}

const rejected = (input: PlanInput, rule: string, unitId: string) =>
  buildCandidates(input).rejections.some((r) => r.rule === rule && r.unitId === unitId);

describe("expiry projection", () => {
  it("uses units oldest first at the site's daily rate", () => {
    // 1 a day: first unit used at 24h, second at 48h
    const p = projectSite([unit("x", "SITE_A", 30), unit("y", "SITE_A", 40)], 1, NOW);
    expect(p.map((x) => [x.unitId, x.hoursToUse, x.outdate])).toEqual([["x", 24, false], ["y", 48, true]]);
  });
  it("projects every unit as an outdate at a site with no demand", () => {
    expect(projectSite([unit("x", "SITE_A", 100)], 0, NOW)[0]!.outdate).toBe(true);
  });
  it("ignores units that aren't available", () => {
    expect(projectSite([unit("x", "SITE_A", 30, { status: "used" })], 1, NOW)).toEqual([]);
  });
});

describe("BR-001 use window after courier arrival", () => {
  it("passes a unit with at least 12h left on arrival", () => {
    expect(buildCandidates(scenario()).candidates.some((c) => c.unitId === "U-A-1" && c.hoursLeftOnArrival >= 12)).toBe(true);
  });
  it("rejects a unit that arrives with under 12h left", () => {
    // Projected outdate at A (A uses 1/day, it's second in line), but expires 13h out and arrives at 4h
    const input = scenario({ units: [unit("U-A-0", "SITE_A", 12), unit("U-A-1", "SITE_A", 15)], slots: [slot("S-1", "SITE_A", "SITE_B", 2)] });
    expect(rejected(input, "BR-001", "U-A-1")).toBe(true);
  });
});

describe("BR-002 only live units", () => {
  it("passes a plan whose units are all in the latest result", () => {
    expect(() => assertLiveUnits([{ unitId: "U-A-1" }], scenario().units)).not.toThrow();
  });
  it("rejects a unit missing from the latest result", () => {
    expect(() => assertLiveUnits([{ unitId: "U-X-9" }], scenario().units)).toThrow(/BR-002/);
  });
  it("rejects a unit no longer available at its source", () => {
    expect(() => assertLiveUnits([{ unitId: "U-A-1" }], [unit("U-A-1", "SITE_A", 40, { status: "used" })])).toThrow(/used/);
  });
});

describe("BR-004 sender safety stock", () => {
  it("passes when the sender keeps its safety stock", () => {
    const input = scenario({ policies: { SITE_A: policy({ safetyStock: 2 }), SITE_B: policy(), SITE_C: policy() } });
    expect(buildCandidates(input).candidates.length).toBeGreaterThan(0);
  });
  it("rejects a move that drops the sender below safety stock", () => {
    const input = scenario({ policies: { SITE_A: policy({ safetyStock: 5 }), SITE_B: policy(), SITE_C: policy() } });
    expect(rejected(input, "BR-004", "U-A-1")).toBe(true);
    expect(buildCandidates(input).candidates).toEqual([]);
  });
});

describe("BR-005 lower usage to higher usage", () => {
  it("passes a move toward the faster-using site", () => {
    expect(buildCandidates(scenario()).candidates.every((c) => c.to === "SITE_B")).toBe(true);
  });
  it("rejects a move to a site that uses the group more slowly", () => {
    expect(buildCandidates(scenario()).rejections.some((r) => r.rule === "BR-005" && r.to === "SITE_C")).toBe(true);
  });
  it("considers the oldest projected outdate first", () => {
    const plan = buildPlan(scenario());
    const expiries = plan.transfers.map((t) => Date.parse(t.unit.expiresAt));
    expect(expiries).toEqual([...expiries].sort((a, b) => a - b));
  });
});

describe("BR-006 at most one transfer per unit", () => {
  it("passes a unit never moved before", () => {
    expect(rejected(scenario(), "BR-006", "U-A-1")).toBe(false);
  });
  it("rejects a unit that was transferred before", () => {
    expect(rejected(scenario({ transferredUnitIds: new Set(["U-A-1"]) }), "BR-006", "U-A-1")).toBe(true);
  });
  it("never puts one unit in two transfers in a plan", () => {
    const ids = buildPlan(scenario()).transfers.map((t) => t.unitId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("BR-007 irradiated units to sites that need them", () => {
  const twoReceivers = (needsC: boolean) => scenario({
    demand: new Map([["SITE_A|O+", 1], ["SITE_B|O+", 10], ["SITE_C|O+", 10]]),
    // Second in line at 1/day, so used at 48h, after its 40h expiry
    units: [unit("U-A-0", "SITE_A", 30), unit("U-A-1", "SITE_A", 40, { irradiated: true })],
    slots: [slot("S-1", "SITE_A", "SITE_B", 2), slot("S-4", "SITE_A", "SITE_C", 2)],
    policies: { SITE_A: policy(), SITE_B: policy(), SITE_C: policy({ needsIrradiated: needsC }) },
  });
  it("ranks the site that needs irradiated units first", () => {
    const ranked = rankCandidates(buildCandidates(twoReceivers(true)).candidates.filter((c) => c.unitId === "U-A-1"));
    expect(ranked[0]!.to).toBe("SITE_C");
  });
  it("doesn't favour a site when none needs irradiated units", () => {
    const ranked = rankCandidates(buildCandidates(twoReceivers(false)).candidates.filter((c) => c.unitId === "U-A-1"));
    expect(ranked.every((c) => !c.irradiatedMatch)).toBe(true);
  });
});

describe("BR-008 declining site excluded", () => {
  it("offers the unit to a site that hasn't declined it", () => {
    expect(buildCandidates(scenario()).candidates.some((c) => c.unitId === "U-A-1" && c.to === "SITE_B")).toBe(true);
  });
  it("never offers the unit to a site that declined it", () => {
    const input = scenario({ declined: new Map([["U-A-1", new Set<SiteId>(["SITE_B"])]]) });
    expect(buildCandidates(input).candidates.some((c) => c.unitId === "U-A-1" && c.to === "SITE_B")).toBe(false);
    expect(rejected(input, "BR-008", "U-A-1")).toBe(true);
  });
});

describe("BR-009 model output limited to the candidate set", () => {
  it("uses the model's choice when it's one of the options", () => {
    const plan = buildPlan(scenario(), (options) => options[options.length - 1]);
    expect(plan.transfers.length).toBeGreaterThan(0);
  });
  it("ignores an invented candidate and falls back to the best deterministic option", () => {
    const invented = { ...buildCandidates(scenario()).candidates[0]!, id: "C-U-FAKE-SITE_B", unitId: "U-FAKE" };
    const plan = buildPlan(scenario(), () => invented);
    expect(plan.transfers.some((t) => t.unitId === "U-FAKE")).toBe(false);
    expect(plan.transfers).toEqual(buildPlan(scenario()).transfers);
  });
});

describe("BR-010 no unit in two live proposals", () => {
  it("passes a unit with no active transfer", () => {
    expect(rejected(scenario(), "BR-010", "U-A-1")).toBe(false);
  });
  it("rejects a unit that already has an active transfer", () => {
    expect(rejected(scenario({ activeUnitIds: new Set(["U-A-1"]) }), "BR-010", "U-A-1")).toBe(true);
  });
});

describe("plan", () => {
  it("uses each courier slot at most once", () => {
    const slots = buildPlan(scenario()).transfers.map((t) => t.slotId);
    expect(new Set(slots).size).toBe(slots.length);
  });
  it("projects fewer outdates after the plan than before", () => {
    const plan = buildPlan(scenario());
    expect(plan.transfers.length).toBeGreaterThan(0);
    expect(plan.outdatesAfter).toBeLessThan(plan.outdatesBefore);
  });
  it("skips a receiver that wouldn't use the unit in time either", () => {
    // B uses only slightly faster and already holds three older units, so an incoming unit waits too long
    const input = scenario({
      demand: new Map([["SITE_A|O+", 1], ["SITE_B|O+", 1.1]]),
      units: [...scenario().units, unit("U-B-0", "SITE_B", 20), unit("U-B-1", "SITE_B", 25), unit("U-B-2", "SITE_B", 28)],
    });
    expect(buildCandidates(input).rejections.some((r) => r.rule === "NO-USE")).toBe(true);
  });
});
