// Deterministic transfer rule. Everything the plan proposes comes from here.
// The model may later choose among these candidates and write messages. It can't add to them.
import type { SiteId } from "./sites.js";
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

// Expiry projection. Each site issues its oldest unit first (FIFO) at its average daily rate,
// matched on ABO and Rh. The k-th unit in line (0-based) is used after (k+1)/rate days.
// A unit is a projected outdate if that's later than its expiry.
// Matching on exact group is conservative. Platelet ABO rules are looser in practice.
export interface Projection {
  unitId: string;
  siteId: SiteId;
  hoursToUse: number;
  hoursToExpiry: number;
  outdate: boolean;
}

export function projectSite(units: StockUnit[], rate: number, now: Date, arrivals: Map<string, number> = new Map()): Projection[] {
  // arrivals: unitId -> hours from now when the unit becomes usable here
  const queue = units
    .filter((u) => u.status === "available")
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
  const perHour = rate / 24;
  const out: Projection[] = [];
  let clock = 0;
  for (const u of queue) {
    const ready = arrivals.get(u.unitId) ?? 0;
    // Issue times advance one unit per 1/rate days, never before the unit is on the shelf
    clock = Math.max(clock + (perHour > 0 ? 1 / perHour : Infinity), ready);
    const hoursToExpiry = hoursUntil(u.expiresAt, now);
    out.push({ unitId: u.unitId, siteId: u.siteId, hoursToUse: clock, hoursToExpiry, outdate: clock > hoursToExpiry });
  }
  return out;
}

export function projectNetwork(units: StockUnit[], demand: Demand, now: Date, arrivals?: Map<string, number>): Projection[] {
  const groups = new Map<string, StockUnit[]>();
  for (const u of units) {
    const k = key(u.siteId, groupOf(u));
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(u);
  }
  const out: Projection[] = [];
  for (const [k, list] of groups) {
    const [site, group] = k.split("|") as [SiteId, string];
    out.push(...projectSite(list, dailyDemand(demand, site, group), now, arrivals));
  }
  return out;
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

    const senderRate = dailyDemand(demand, unit.siteId, group);
    for (const to of sites) {
      if (to === unit.siteId) continue;
      if (input.declined.get(unit.unitId)?.has(to)) {
        rejections.push({ unitId: unit.unitId, to, rule: "BR-008", reason: `${to} declined this unit` });
        continue;
      }
      const receiverRate = dailyDemand(demand, to, group);
      if (receiverRate <= senderRate) {
        rejections.push({ unitId: unit.unitId, to, rule: "BR-005", reason: `${to} uses ${group} no faster than ${unit.siteId}` });
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
        const receiverUnits = units.filter((u) => u.siteId === to && groupOf(u) === group);
        const moved = { ...unit, siteId: to };
        const proj = projectSite([...receiverUnits, moved], receiverRate, now, new Map([[unit.unitId, arrival]]));
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
export function buildPlan(input: PlanInput, choose: (options: Candidate[]) => Candidate | undefined = (o) => o[0]): Plan {
  const { candidates, rejections, projectedOutdates } = buildCandidates(input);
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
