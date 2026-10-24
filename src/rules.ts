// Deterministic transfer rule. Everything the plan proposes comes from here.
// The model may later choose among these candidates and write messages. It can't add to them.
import type { SiteId } from "./sites.js";
import { acceptableFor } from "./compat.js";
import type { CourierSlot, StockUnit } from "./stock.js";

const HOUR = 3_600_000;

// BR-001: a unit must still have this much life left when the courier arrives. Assumed value.
export const USE_WINDOW_HOURS = 12;

export interface SitePolicy {
  // BR-004: available units per ABO and Rh group a sender always keeps. Assumed default.
  safetyStock: number;
  // BR-007: the site treats patients who need irradiated platelets
  needsIrradiated: boolean;
}

export interface PlanInput {
  now: Date;
  units: StockUnit[];
  // Mean units used per day, by site and group, from usage history
  demand: Demand;
  slots: CourierSlot[];
  policies: Record<SiteId, SitePolicy>;
  // BR-006: units moved before, which can't move again
  transferredUnitIds: Set<string>;
  // BR-010: units already in a live proposal or transfer
  activeUnitIds: Set<string>;
  // BR-008: sites that declined a unit, which are never offered it again
  declined: Map<string, Set<SiteId>>;
}

export type Demand = Map<string, number>;

export function groupOf(u: { abo: string; rh: string }): string {
  return `${u.abo}${u.rh}`;
}

function key(site: SiteId, group: string): string {
  return `${site}|${group}`;
}

export function dailyDemand(demand: Demand, site: SiteId, group: string): number {
  return demand.get(key(site, group)) ?? 0;
}

export function buildDemand(rows: { site_id: string; abo: string; rh: string; days: number; used: number }[]): Demand {
  const d: Demand = new Map();
  for (const r of rows) {
    if (r.days > 0) d.set(key(r.site_id as SiteId, `${r.abo}${r.rh}`), r.used / r.days);
  }
  return d;
}

function hoursUntil(iso: string, now: Date): number {
  return (Date.parse(iso) - now.getTime()) / HOUR;
}

// Expiry projection. Hour by hour, each patient group at a site draws on stock at its
// average daily rate. Each draw takes the oldest unit of the best acceptable group on the
// shelf (src/compat.ts), never an expired unit or one still in transit. A unit nobody
// draws before it expires is a projected outdate.
export interface Projection {
  unitId: string;
  siteId: SiteId;
  hoursToUse: number;
  hoursToExpiry: number;
  outdate: boolean;
}

const HORIZON_HOURS = 168;

export function siteRates(demand: Demand, site: SiteId): Map<string, number> {
  const rates = new Map<string, number>();
  for (const [k, v] of demand) {
    const [s, group] = k.split("|") as [string, string];
    if (s === site && v > 0) rates.set(group, v);
  }
  return rates;
}

export function projectSite(units: StockUnit[], rates: Map<string, number>, now: Date, arrivals: Map<string, number> = new Map()): Projection[] {
  // arrivals: unitId -> hours from now when the unit becomes usable here
  const shelf = units
    .filter((u) => u.status === "available")
    .map((u) => ({ u, group: groupOf(u), expiry: hoursUntil(u.expiresAt, now), ready: arrivals.get(u.unitId) ?? 0, usedAt: Infinity }))
    .sort((a, b) => a.expiry - b.expiry || a.u.unitId.localeCompare(b.u.unitId));
  // Highest-demand groups draw first within an hour, so ordering is deterministic
  const patients = [...rates.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const choices = new Map(patients.map(([p]) => [p, acceptableFor(p)]));
  // Accumulated demand in unit-hours per day: one unit is due each time it reaches 24
  const due = new Map(patients.map(([p]) => [p, 0]));
  const horizon = Math.min(HORIZON_HOURS, Math.ceil(Math.max(0, ...shelf.map((x) => x.expiry))));
  for (let t = 1; t <= horizon; t++) {
    for (const [p, rate] of patients) {
      let owed = due.get(p)! + rate;
      while (owed >= 24 - 1e-9) {
        owed -= 24;
        for (const g of choices.get(p)!) {
          const pick = shelf.find((x) => x.group === g && x.usedAt === Infinity && x.ready <= t && x.expiry >= t);
          if (pick) {
            pick.usedAt = t;
            break;
          }
        }
      }
      due.set(p, owed);
    }
  }
  return shelf.map((x) => ({ unitId: x.u.unitId, siteId: x.u.siteId, hoursToUse: x.usedAt, hoursToExpiry: x.expiry, outdate: x.usedAt === Infinity }));
}

export function projectNetwork(units: StockUnit[], demand: Demand, now: Date, arrivals?: Map<string, number>): Projection[] {
  const sites = [...new Set(units.map((u) => u.siteId))];
  return sites.flatMap((site) => projectSite(units.filter((u) => u.siteId === site), siteRates(demand, site), now, arrivals));
}

// Daily demand at a site from every patient group that can receive this unit group
export function compatibleDemand(demand: Demand, site: SiteId, unitGroup: string): number {
  let total = 0;
  for (const [p, rate] of siteRates(demand, site)) if (acceptableFor(p).includes(unitGroup)) total += rate;
  return total;
}

export type RuleId = "BR-001" | "BR-002" | "BR-004" | "BR-005" | "BR-006" | "BR-007" | "BR-008" | "BR-010" | "SLOT" | "NO-USE";

export interface Candidate {
  id: string;
  unitId: string;
  from: SiteId;
  to: SiteId;
  slotId: string;
  arrivesAt: string;
  hoursLeftOnArrival: number;
  // Projected hours from arrival until the receiver uses the unit
  hoursToUseAtReceiver: number;
  irradiatedMatch: boolean;
  unit: StockUnit;
}

export interface Rejection {
  unitId: string;
  to?: SiteId;
  rule: RuleId;
  reason: string;
}

export interface CandidateResult {
  candidates: Candidate[];
  rejections: Rejection[];
  projectedOutdates: Projection[];
}

// Builds every transfer that passes all business rules, for units projected to expire unused.
export function buildCandidates(input: PlanInput): CandidateResult {
  const { now, units, demand, slots, policies } = input;
  const projections = projectNetwork(units, demand, now);
  const outdates = projections.filter((p) => p.outdate);
  const byId = new Map(units.map((u) => [u.unitId, u]));
  const candidates: Candidate[] = [];
  const rejections: Rejection[] = [];
  const sites = Object.keys(policies) as SiteId[];

  // Oldest first (BR-005)
  outdates.sort((a, b) => a.hoursToExpiry - b.hoursToExpiry);

  for (const p of outdates) {
    const unit = byId.get(p.unitId)!;
    const group = groupOf(unit);

    if (input.transferredUnitIds.has(unit.unitId)) {
      rejections.push({ unitId: unit.unitId, rule: "BR-006", reason: "Unit has already been transferred once" });
      continue;
    }
    if (input.activeUnitIds.has(unit.unitId)) {
      rejections.push({ unitId: unit.unitId, rule: "BR-010", reason: "Unit already has an active transfer" });
      continue;
    }
    // BR-004: count what the sender keeps if this unit leaves
    const senderAvailable = units.filter((u) => u.siteId === unit.siteId && u.status === "available" && groupOf(u) === group).length;
    if (senderAvailable - 1 < policies[unit.siteId].safetyStock) {
      rejections.push({ unitId: unit.unitId, rule: "BR-004", reason: `${unit.siteId} would drop below safety stock for ${group}` });
      continue;
    }

    const senderRate = compatibleDemand(demand, unit.siteId, group);
    for (const to of sites) {
      if (to === unit.siteId) continue;
      if (input.declined.get(unit.unitId)?.has(to)) {
        rejections.push({ unitId: unit.unitId, to, rule: "BR-008", reason: `${to} declined this unit` });
        continue;
      }
      const receiverRate = compatibleDemand(demand, to, group);
      if (receiverRate <= senderRate) {
        rejections.push({ unitId: unit.unitId, to, rule: "BR-005", reason: `${to} has no more demand that ${group} can serve than ${unit.siteId}` });
        continue;
      }
      const routeSlots = slots
        .filter((s) => s.fromSite === unit.siteId && s.toSite === to && s.status === "open" && Date.parse(s.departsAt) > now.getTime())
        .sort((a, b) => Date.parse(a.arrivesAt) - Date.parse(b.arrivesAt));
      if (routeSlots.length === 0) {
        rejections.push({ unitId: unit.unitId, to, rule: "SLOT", reason: `No open courier slot ${unit.siteId} to ${to}` });
        continue;
      }
      // One candidate per usable slot, so the plan can fall back to a later run when an earlier one is taken.
      // The first failing reason is reported only when no slot on the route works.
      let firstFailure: Rejection | null = null;
      let found = false;
      for (const slot of routeSlots) {
        const hoursLeftOnArrival = (Date.parse(unit.expiresAt) - Date.parse(slot.arrivesAt)) / HOUR;
        if (hoursLeftOnArrival < USE_WINDOW_HOURS) {
          firstFailure ??= { unitId: unit.unitId, to, rule: "BR-001", reason: `Only ${hoursLeftOnArrival.toFixed(1)}h left on arrival, under the ${USE_WINDOW_HOURS}h use window` };
          continue;
        }
        // Would the receiver actually use it in time, behind its own stock?
        const arrival = (Date.parse(slot.arrivesAt) - now.getTime()) / HOUR;
        // The whole receiving shelf competes, since compatible groups serve the same patients
        const receiverUnits = units.filter((u) => u.siteId === to);
        const moved = { ...unit, siteId: to };
        const proj = projectSite([...receiverUnits, moved], siteRates(demand, to), now, new Map([[unit.unitId, arrival]]));
        const mine = proj.find((x) => x.unitId === unit.unitId)!;
        if (mine.outdate) {
          firstFailure ??= { unitId: unit.unitId, to, rule: "NO-USE", reason: `${to} wouldn't use it before expiry either` };
          continue;
        }
        found = true;
        candidates.push({
          id: `C-${unit.unitId}-${to}-${slot.slotId}`,
          unitId: unit.unitId,
          from: unit.siteId,
          to,
          slotId: slot.slotId,
          arrivesAt: slot.arrivesAt,
          hoursLeftOnArrival,
          hoursToUseAtReceiver: mine.hoursToUse - arrival,
          irradiatedMatch: unit.irradiated && policies[to].needsIrradiated,
          unit,
        });
      }
      if (!found && firstFailure) rejections.push(firstFailure);
    }
  }
  return { candidates, rejections, projectedOutdates: outdates };
}

// BR-007 then margin: irradiated units go to sites that need them first, then the
// receiver with the most life left on the unit at the time it's used.
export function rankCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) =>
      Number(b.irradiatedMatch) - Number(a.irradiatedMatch) ||
      b.hoursLeftOnArrival - b.hoursToUseAtReceiver - (a.hoursLeftOnArrival - a.hoursToUseAtReceiver) ||
      a.id.localeCompare(b.id),
  );
}

export interface Transfer {
  candidateId: string;
  unitId: string;
  from: SiteId;
  to: SiteId;
  slotId: string;
  arrivesAt: string;
  unit: StockUnit;
}

export interface Plan {
  transfers: Transfer[];
  rejections: Rejection[];
  outdatesBefore: number;
  outdatesAfter: number;
  candidatesConsidered: number;
}

// Picks at most one transfer per unit and one unit per courier slot, best candidate first,
// then reprojects the network with the moves applied for the after count.
// `only` narrows the candidates, for a replan of one unit or one receiving site.
export function buildPlan(
  input: PlanInput,
  choose: (options: Candidate[]) => Candidate | undefined = (o) => o[0],
  only: (c: Candidate) => boolean = () => true,
): Plan {
  const built = buildCandidates(input);
  const { rejections, projectedOutdates } = built;
  const candidates = built.candidates.filter(only);
  const byUnit = new Map<string, Candidate[]>();
  for (const c of candidates) (byUnit.get(c.unitId) ?? byUnit.set(c.unitId, []).get(c.unitId)!).push(c);

  const usedSlots = new Set<string>();
  const transfers: Transfer[] = [];
  for (const p of projectedOutdates) {
    const options = rankCandidates(byUnit.get(p.unitId) ?? []).filter((c) => !usedSlots.has(c.slotId));
    if (options.length === 0) continue;
    const pick = choose(options);
    // BR-009: anything outside the offered set is ignored, and the best deterministic option is used
    const chosen = pick && options.some((o) => o.id === pick.id) ? pick : options[0]!;
    usedSlots.add(chosen.slotId);
    transfers.push({
      candidateId: chosen.id,
      unitId: chosen.unitId,
      from: chosen.from,
      to: chosen.to,
      slotId: chosen.slotId,
      arrivesAt: chosen.arrivesAt,
      unit: chosen.unit,
    });
  }

  const moved = new Map(transfers.map((t) => [t.unitId, t]));
  const after = input.units.map((u) => (moved.has(u.unitId) ? { ...u, siteId: moved.get(u.unitId)!.to } : u));
  const arrivals = new Map(transfers.map((t) => [t.unitId, (Date.parse(t.arrivesAt) - input.now.getTime()) / HOUR]));
  return {
    transfers,
    rejections,
    outdatesBefore: projectedOutdates.length,
    outdatesAfter: projectNetwork(after, input.demand, input.now, arrivals).filter((p) => p.outdate).length,
    candidatesConsidered: candidates.length,
  };
}

// BR-002: every unit a plan names must be in the latest Zetaris result, still available.
export function assertLiveUnits(transfers: { unitId: string }[], latest: StockUnit[]): void {
  const live = new Map(latest.map((u) => [u.unitId, u]));
  for (const t of transfers) {
    const u = live.get(t.unitId);
    if (!u) throw new Error(`BR-002: ${t.unitId} isn't in the latest Zetaris result`);
    if (u.status !== "available") throw new Error(`BR-002: ${t.unitId} is ${u.status} at its source`);
  }
}
