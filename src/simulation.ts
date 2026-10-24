// 30-day simulation of the network, with and without the transfer rule.
// A labeled supporting check for the M2 gate. It never reads or writes live data.
import { buildPlan, type Demand } from "./rules.js";
import { poisson, rng } from "./random.js";
import { acceptableFor } from "./compat.js";
import { BLOOD_GROUPS, SITE_POLICIES, type SiteId } from "./sites.js";
import type { CourierSlot, StockUnit } from "./stock.js";

const HOUR = 3_600_000;

export interface SimSite {
  id: SiteId;
  // Mean platelet units used per day, all groups
  dailyUse: number;
  // Each morning the site orders up to this many days of its own demand, per group
  parDays: number;
}

// Same shape as the demo seed: Site A over-orders for its usage, Site B runs lean.
export const DEFAULT_SITES: SimSite[] = [
  { id: "SITE_A", dailyUse: 2, parDays: 3 },
  { id: "SITE_B", dailyUse: 6, parDays: 1.5 },
  { id: "SITE_C", dailyUse: 3, parDays: 2 },
];

export interface SimResult {
  policy: "no-sharing" | "rule";
  supplied: number;
  issued: number;
  outdates: number;
  shortages: number;
  transfers: number;
  outdatesByGroup: Record<string, number>;
}

// Deterministic sub-stream per purpose, so both policies see identical demand and supply draws
function stream(seed: number, ...parts: number[]): () => number {
  let h = seed >>> 0;
  for (const p of parts) h = Math.imul(h ^ (p + 0x9e3779b9), 0x85ebca6b) >>> 0;
  return rng(h);
}

export function simulate(opts: { seed: number; policy: "no-sharing" | "rule"; days?: number; warmupDays?: number; sites?: SimSite[]; groups?: [string, string, number][] }): SimResult {
  const { seed, policy } = opts;
  const days = opts.days ?? 30;
  const warmup = opts.warmupDays ?? 5;
  const sites = opts.sites ?? DEFAULT_SITES;
  const groups = opts.groups ?? BLOOD_GROUPS;
  const start = Date.parse("2026-01-01T06:00:00Z");
  const demand: Demand = new Map();
  for (const s of sites) for (const [abo, rh, share] of groups) demand.set(`${s.id}|${abo}${rh}`, s.dailyUse * share);

  let stock: StockUnit[] = [];
  const transferred = new Set<string>();
  const result: SimResult = { policy, supplied: 0, issued: 0, outdates: 0, shortages: 0, transfers: 0, outdatesByGroup: {} };
  let serial = 0;

  for (let day = 0; day < warmup + days; day++) {
    const morning = start + day * 24 * HOUR;
    const counting = day >= warmup;

    // 1. Supplier delivery up to each site's par level. Units arrive with 3 to 4 days of life.
    // Sites don't stock AB platelets: SNBTS Table 1 notes group AB platelets are unlikely to be
    // available, and AB patients take A or B. AB demand is added to the A and B par, split evenly.
    sites.forEach((site, si) => {
      groups.forEach(([abo, rh, share], gi) => {
        if (abo === "AB") return;
        const r = stream(seed, 1, day, si, gi);
        const abShare = abo === "A" || abo === "B" ? (groups.find(([a, h]) => a === "AB" && h === rh)?.[2] ?? 0) / 2 : 0;
        const par = Math.ceil(site.parDays * site.dailyUse * (share + abShare));
        const onHand = stock.filter((u) => u.siteId === site.id && u.abo === abo && u.rh === rh).length;
        for (let i = 0; i < Math.max(0, par - onHand); i++) {
          stock.push({
            unitId: `SIM-${++serial}`, siteId: site.id, abo, rh, irradiated: r() < 0.3,
            expiresAt: new Date(morning + (72 + Math.floor(r() * 24)) * HOUR).toISOString(),
            status: "available", reservedFor: null, source: "simulation",
          });
          if (counting) result.supplied++;
        }
      });
    });

    // 2. The morning plan, run by the same rule engine as the live app
    if (policy === "rule") {
      const slots: CourierSlot[] = [];
      for (const from of sites) for (const to of sites) {
        if (from.id === to.id) continue;
        for (const dep of [2, 6, 10]) {
          slots.push({
            slotId: `${day}-${from.id}-${to.id}-${dep}`, fromSite: from.id, toSite: to.id,
            departsAt: new Date(morning + dep * HOUR).toISOString(), arrivesAt: new Date(morning + (dep + 2) * HOUR).toISOString(),
            status: "open", bookingId: null,
          });
        }
      }
      const plan = buildPlan({
        now: new Date(morning), units: stock, demand, slots, policies: SITE_POLICIES,
        transferredUnitIds: transferred, activeUnitIds: new Set(), declined: new Map(),
      });
      const moves = new Map(plan.transfers.map((t) => [t.unitId, t.to]));
      stock = stock.map((u) => (moves.has(u.unitId) ? { ...u, siteId: moves.get(u.unitId)! } : u));
      for (const id of moves.keys()) transferred.add(id);
      if (counting) result.transfers += moves.size;
    }

    // 3. The day's demand, met with units still in date at midday. Every patient group takes
    // its identical group first, and only then do groups fall back to compatible choices
    // (src/compat.ts), oldest unit first. Both policies issue this way.
    const midday = morning + 6 * HOUR;
    sites.forEach((site, si) => {
      const need = groups.map(([abo, rh, share], gi) => ({
        patient: `${abo}${rh}`,
        left: poisson(stream(seed, 2, day, si, gi), site.dailyUse * share),
      }));
      const wanted = need.reduce((n, x) => n + x.left, 0);
      const usedIds = new Set<string>();
      for (let rank = 0; rank < 6; rank++) {
        for (const n of need) {
          const g = acceptableFor(n.patient)[rank];
          if (!g || n.left === 0) continue;
          const shelf = stock
            .filter((u) => u.siteId === site.id && `${u.abo}${u.rh}` === g && !usedIds.has(u.unitId) && Date.parse(u.expiresAt) > midday)
            .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
          for (const u of shelf.slice(0, n.left)) usedIds.add(u.unitId);
          n.left -= Math.min(n.left, shelf.length);
        }
      }
      stock = stock.filter((u) => !usedIds.has(u.unitId));
      if (counting) {
        result.issued += usedIds.size;
        result.shortages += wanted - usedIds.size;
      }
    });

    // 4. Overnight, anything that expires before tomorrow morning is thrown out
    const tomorrow = morning + 24 * HOUR;
    const expired = stock.filter((u) => Date.parse(u.expiresAt) <= tomorrow);
    stock = stock.filter((u) => Date.parse(u.expiresAt) > tomorrow);
    if (counting) {
      result.outdates += expired.length;
      for (const u of expired) result.outdatesByGroup[`${u.abo}${u.rh}`] = (result.outdatesByGroup[`${u.abo}${u.rh}`] ?? 0) + 1;
    }
  }
  return result;
}

export interface SimSummary {
  runs: number;
  days: number;
  noSharing: { outdates: number; shortages: number; supplied: number };
  rule: { outdates: number; shortages: number; supplied: number; transfers: number };
  outdateReduction: number;
  outdateReductionRange: [number, number];
  perSeed: { seed: number; noSharing: SimResult; rule: SimResult }[];
}

export function compare(seeds: number[], days = 30, groups?: [string, string, number][]): SimSummary {
  const perSeed = seeds.map((seed) => ({
    seed,
    noSharing: simulate({ seed, policy: "no-sharing", days, groups }),
    rule: simulate({ seed, policy: "rule", days, groups }),
  }));
  const mean = (f: (r: (typeof perSeed)[number]) => number) => perSeed.reduce((n, r) => n + f(r), 0) / perSeed.length;
  const reductions = perSeed.map((r) => (r.noSharing.outdates ? 1 - r.rule.outdates / r.noSharing.outdates : 0));
  const base = mean((r) => r.noSharing.outdates);
  return {
    runs: seeds.length,
    days,
    noSharing: { outdates: base, shortages: mean((r) => r.noSharing.shortages), supplied: mean((r) => r.noSharing.supplied) },
    rule: { outdates: mean((r) => r.rule.outdates), shortages: mean((r) => r.rule.shortages), supplied: mean((r) => r.rule.supplied), transfers: mean((r) => r.rule.transfers) },
    outdateReduction: base ? 1 - mean((r) => r.rule.outdates) / base : 0,
    outdateReductionRange: [Math.min(...reductions), Math.max(...reductions)],
    perSeed,
  };
}
