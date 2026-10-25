// The morning plan and replans: read live stock and usage through Zetaris, run the rule,
// let Nemotron choose among rule-approved candidates and write requests, and record each
// transfer in the World Model.
import { randomUUID } from "node:crypto";
import { SITES, SITE_POLICIES, type SiteId } from "./sites.js";
import { readNetworkStock, readRoutes, readUsage, type NetworkStock, type Querier, type Routes } from "./stock.js";
import { assertLiveUnits, buildCandidates, buildDemand, buildPlan, groupOf, rankCandidates, type Candidate, type PlanInput, type Transfer } from "./rules.js";
import { ACTIVE, MOVED, type TransferRecord, type TransferStore } from "./transfers.js";
import { templateDecider, type Decider, type DecisionOutcome, type DecisionRequest } from "./nemotron.js";
import type { DeclineMemory } from "./declineMemory.js";

export interface PlannerDeps {
  zetaris: Querier;
  store: TransferStore;
  decider: Decider;
  memory: DeclineMemory;
}

const siteName = (id: SiteId) => SITES.find((s) => s.id === id)?.name ?? id;

// Options shown to the model per unit. Enough to choose, small enough to keep the prompt bounded.
const OPTIONS_PER_UNIT = 4;

export function templateMessage(t: Transfer): string {
  const hours = Math.round((Date.parse(t.unit.expiresAt) - Date.parse(t.arrivesAt)) / 3_600_000);
  return `${siteName(t.from)} can send platelet unit ${t.unitId} (${t.unit.abo}${t.unit.rh}${t.unit.irradiated ? ", irradiated" : ""}) on courier slot ${t.slotId}. ` +
    `It arrives with ${hours}h of shelf life left and is projected to expire unused at ${siteName(t.from)}. Accept if ${siteName(t.to)} can use it.`;
}

export class PlanAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanAborted";
  }
}

export interface PlanRun {
  planId: string;
  ranAt: string;
  model: "nemotron" | "template";
  modelNotice?: string;
  outdatesBefore: number;
  outdatesAfter: number;
  candidatesConsidered: number;
  rejectionsByRule: Record<string, number>;
  modelRejections: number;
  transfers: TransferRecord[];
}

interface LiveContext {
  stock: NetworkStock;
  input: PlanInput;
  live: TransferRecord[];
  routes: Routes;
}

async function readLive(deps: PlannerDeps, now: Date, superseding: boolean): Promise<LiveContext> {
  const [stock, usage, routes] = await Promise.all([
    readNetworkStock(deps.zetaris),
    readUsage(deps.zetaris).catch(() => null),
    readRoutes(deps.zetaris).catch(() => null),
  ]);
  // No cached data stands in for a live read. A plan over part of the network could move
  // units toward a site whose stock we can't see, so the run stops.
  const down = stock.sites.filter((s) => !s.status.ok).map((s) => s.site.name);
  if (!stock.courier.status.ok) down.push("the courier service");
  if (down.length === stock.sites.length + 1) throw new PlanAborted("Plan not run: Zetaris isn't answering, so no source can be read.");
  if (down.length) throw new PlanAborted(`Plan not run: can't read ${down.join(", ")} right now.`);
  if (!usage) throw new PlanAborted("Plan not run: can't read usage history through Zetaris.");
  if (!routes) throw new PlanAborted("Plan not run: the cross-site route query through Zetaris failed.");

  const existing = deps.store.list();
  if (superseding) {
    // Unsent proposals from an earlier run are replaced by this run
    for (const t of existing.filter((t) => t.state === "proposed")) {
      await deps.store.transition(t.id, "superseded", "planner", "Replaced by a newer plan run");
    }
  }
  const live = deps.store.list().filter((t) => t.state !== "superseded");
  const declined = new Map<string, Set<SiteId>>();
  for (const t of live.filter((t) => t.state === "declined")) {
    (declined.get(t.unitId) ?? declined.set(t.unitId, new Set()).get(t.unitId)!).add(t.to);
  }
  const input: PlanInput = {
    now,
    units: stock.sites.flatMap((s) => s.units),
    demand: buildDemand(usage),
    // A slot held by a live transfer isn't free, even before the courier books it at accept
    slots: stock.courier.slots.filter((slot) => !live.some((t) => ACTIVE.includes(t.state) && t.slotId === slot.slotId)),
    policies: SITE_POLICIES,
    transferredUnitIds: new Set(live.filter((t) => MOVED.includes(t.state)).map((t) => t.unitId)),
    activeUnitIds: new Set(live.filter((t) => ACTIVE.includes(t.state)).map((t) => t.unitId)),
    declined,
    routes: routes.pairs,
  };
  return { stock, input, live, routes };
}

function requestsFor(candidates: Candidate[], deps: PlannerDeps): DecisionRequest[] {
  const byUnit = new Map<string, Candidate[]>();
  for (const c of candidates) (byUnit.get(c.unitId) ?? byUnit.set(c.unitId, []).get(c.unitId)!).push(c);
  return [...byUnit.values()].map((list) => {
    const options = rankCandidates(list).slice(0, OPTIONS_PER_UNIT);
    const u = options[0]!.unit;
    const receivers = [...new Set(options.map((o) => o.to))];
    return {
      unitId: u.unitId,
      group: groupOf(u),
      irradiated: u.irradiated,
      from: u.siteId,
      fromName: siteName(u.siteId),
      expiresAt: u.expiresAt,
      options: options.map((o) => ({
        candidateId: o.id,
        to: o.to,
        toName: siteName(o.to),
        slotId: o.slotId,
        arrivesAt: o.arrivesAt,
        hoursLeftOnArrival: o.hoursLeftOnArrival,
        receiverNeedsIrradiated: SITE_POLICIES[o.to].needsIrradiated,
      })),
      notes: receivers.flatMap((site) => deps.memory.forSite(site, 3)),
    };
  });
}

interface Chosen {
  plan: ReturnType<typeof buildPlan>;
  outcome: DecisionOutcome;
  model: "nemotron" | "template";
  notice?: string;
}

async function choose(deps: PlannerDeps, input: PlanInput, only: (c: Candidate) => boolean): Promise<Chosen> {
  const candidates = buildCandidates(input).candidates.filter(only);
  let outcome: DecisionOutcome = { decisions: new Map(), rejected: [] };
  let model: "nemotron" | "template" = deps.decider.name;
  let notice: string | undefined;
  if (deps.decider.name === "template") {
    notice = "Nemotron isn't configured. Requests use the standard template.";
  } else if (candidates.length) {
    try {
      outcome = await deps.decider.decide(requestsFor(candidates, deps));
    } catch (err) {
      console.error("Nemotron failed:", err instanceof Error ? err.message : err);
      model = "template";
      notice = "Nemotron didn't respond with valid output. Requests use the standard template.";
    }
  }
  const byId = new Map(candidates.map((c) => [c.id, c]));
  // BR-009 again inside buildPlan: a pick whose slot was taken by an earlier unit isn't offered, so the best option is used
  const plan = buildPlan(
    input,
    (options) => {
      const d = options[0] ? outcome.decisions.get(options[0].unitId) : undefined;
      const pick = d && byId.get(d.candidateId);
      if (!pick) return options[0];
      // If an earlier unit took the model's slot, keep the model's receiving site on its next free slot
      return options.find((o) => o.id === pick.id) ?? options.find((o) => o.to === pick.to) ?? options[0];
    },
    only,
  );
  assertLiveUnits(plan.transfers, input.units);
  if (outcome.rejected.length && !notice) notice = `${outcome.rejected.length} model choice${outcome.rejected.length === 1 ? " was" : "s were"} outside the rule-approved options and replaced.`;
  return { plan, outcome, model, notice };
}

async function record(deps: PlannerDeps, ctx: LiveContext, chosen: Chosen, planId: string, transfers: Transfer[], replaces?: string): Promise<TransferRecord[]> {
  const out: TransferRecord[] = [];
  for (const t of transfers) {
    const d = chosen.outcome.decisions.get(t.unitId);
    const byModel = chosen.model === "nemotron" && d?.candidateId === t.candidateId;
    const site = ctx.stock.sites.find((s) => s.site.id === t.from)!;
    out.push(
      await deps.store.create(
        {
          id: `${planId}-${t.unitId}`,
          planId,
          unitId: t.unitId,
          from: t.from,
          to: t.to,
          slotId: t.slotId,
          arrivesAt: t.arrivesAt,
          abo: t.unit.abo,
          rh: t.unit.rh,
          irradiated: t.unit.irradiated,
          message: byModel ? d!.message : templateMessage(t),
          messageBy: byModel ? "nemotron" : "template",
          evidence: {
            source: t.unit.source,
            sql: ctx.routes.sql,
            queriedAt: ctx.routes.queriedAt,
            status: t.unit.status,
            expiresAt: t.unit.expiresAt,
          },
          ...(replaces ? { replaces } : {}),
        },
        "planner",
      ),
    );
  }
  return out;
}

function newId(prefix: string, now: Date): string {
  return `${prefix}-${now.toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${randomUUID().slice(0, 4)}`;
}

export async function runPlan(deps: PlannerDeps, now = new Date()): Promise<PlanRun> {
  const ctx = await readLive(deps, now, true);
  const chosen = await choose(deps, ctx.input, () => true);
  const planId = newId("P", now);
  const transfers = await record(deps, ctx, chosen, planId, chosen.plan.transfers);
  const rejectionsByRule: Record<string, number> = {};
  for (const r of chosen.plan.rejections) rejectionsByRule[r.rule] = (rejectionsByRule[r.rule] ?? 0) + 1;
  return {
    planId,
    ranAt: now.toISOString(),
    model: chosen.model,
    modelNotice: chosen.notice,
    outdatesBefore: chosen.plan.outdatesBefore,
    outdatesAfter: chosen.plan.outdatesAfter,
    candidatesConsidered: chosen.plan.candidatesConsidered,
    rejectionsByRule,
    modelRejections: chosen.outcome.rejected.length,
    transfers,
  };
}

export interface Replan {
  original: TransferRecord;
  replacement: TransferRecord | null;
  note: string;
  model: "nemotron" | "template";
  modelNotice?: string;
}

// After a decline: the same unit to another site (BR-008 keeps the declining site out).
// After a refusal: another unit for the same receiving site, since the original is gone at its source.
export async function replan(deps: PlannerDeps, transferId: string, now = new Date()): Promise<Replan> {
  const original = deps.store.get(transferId);
  if (!original || (original.state !== "declined" && original.state !== "refused")) {
    throw new Error(`Transfer ${transferId} isn't declined or refused`);
  }
  if (original.replacementId || original.replacementNote) {
    return { original, replacement: original.replacementId ? deps.store.get(original.replacementId) ?? null : null, note: original.replacementNote ?? "", model: "template" };
  }
  let ctx: LiveContext;
  try {
    ctx = await readLive(deps, now, false);
  } catch (err) {
    const note = err instanceof PlanAborted ? `No replacement yet: ${err.message.replace(/^Plan not run: /, "")}` : "No replacement yet: the live read failed.";
    return { original, replacement: null, note, model: "template" };
  }
  const only = original.state === "declined"
    ? (c: Candidate) => c.unitId === original.unitId && c.to !== original.to
    : (c: Candidate) => c.to === original.to && c.unitId !== original.unitId;
  const chosen = await choose(deps, ctx.input, only);
  const pick = chosen.plan.transfers[0];
  if (!pick) {
    const note = original.state === "declined"
      ? `No other site can use ${original.unitId} before it expires.`
      : `No other unit can reach ${siteName(original.to)} in time right now.`;
    const updated = await deps.store.annotate(transferId, "planner", { replacementNote: note });
    return { original: updated, replacement: null, note, model: chosen.model, modelNotice: chosen.notice };
  }
  const [replacement] = await record(deps, ctx, chosen, newId("R", now), [pick], transferId);
  const note = `Replacement offered: ${pick.unitId} from ${siteName(pick.from)} to ${siteName(pick.to)}.`;
  const updated = await deps.store.annotate(transferId, "planner", { replacementId: replacement!.id, replacementNote: note });
  return { original: updated, replacement: replacement!, note, model: chosen.model, modelNotice: chosen.notice };
}

// Coordinator sends every proposal to the receiving sites' inboxes
export async function sendProposals(store: TransferStore, by: string): Promise<TransferRecord[]> {
  const sent: TransferRecord[] = [];
  for (const t of store.list().filter((t) => t.state === "proposed")) {
    sent.push(await store.transition(t.id, "requested", by));
  }
  return sent;
}
