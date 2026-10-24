// The morning plan: read live stock and usage through Zetaris, run the rule,
// write each chosen transfer to the World Model as proposed, then send.
import { randomUUID } from "node:crypto";
import { SITES, SITE_POLICIES, type SiteId } from "./sites.js";
import { readNetworkStock, readUsage, type Querier } from "./stock.js";
import { assertLiveUnits, buildCandidates, buildDemand, buildPlan, rankCandidates, type Candidate, type Transfer } from "./rules.js";
import { ACTIVE, MOVED, type TransferRecord, type TransferStore } from "./transfers.js";

// Writes the request text and may pick among rule-approved candidates.
// The template messenger is the fallback when no model is configured or the model fails.
export interface Messenger {
  readonly name: "template" | "nemotron";
  choose(options: Candidate[]): Promise<Candidate | undefined>;
  write(t: Transfer): Promise<string>;
}

const siteName = (id: SiteId) => SITES.find((s) => s.id === id)?.name ?? id;

export const templateMessenger: Messenger = {
  name: "template",
  choose: async (options) => options[0],
  write: async (t) => {
    const hours = Math.round((Date.parse(t.unit.expiresAt) - Date.parse(t.arrivesAt)) / 3_600_000);
    return `${siteName(t.from)} can send platelet unit ${t.unitId} (${t.unit.abo}${t.unit.rh}${t.unit.irradiated ? ", irradiated" : ""}) on courier slot ${t.slotId}. ` +
      `It arrives with ${hours}h of shelf life left and is projected to expire unused at ${siteName(t.from)}. Accept if ${siteName(t.to)} can use it.`;
  },
};

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
  transfers: TransferRecord[];
}

export async function runPlan(zetaris: Querier, store: TransferStore, messenger: Messenger, now = new Date()): Promise<PlanRun> {
  const [stock, usage] = await Promise.all([readNetworkStock(zetaris), readUsage(zetaris).catch(() => null)]);
  // No cached data stands in for a live read. A plan over part of the network could move
  // units toward a site whose stock we can't see, so the run stops.
  const down = stock.sites.filter((s) => !s.status.ok).map((s) => s.site.name);
  if (!stock.courier.status.ok) down.push("the courier service");
  if (down.length) throw new PlanAborted(`Plan not run: can't read ${down.join(", ")} right now.`);
  if (!usage) throw new PlanAborted("Plan not run: can't read usage history through Zetaris.");

  const existing = store.list();
  // Unsent proposals from an earlier run are replaced by this run
  for (const t of existing.filter((t) => t.state === "proposed")) {
    await store.transition(t.id, "superseded", "planner", "Replaced by a newer plan run");
  }
  const live = existing.filter((t) => t.state !== "proposed");
  const declined = new Map<string, Set<SiteId>>();
  for (const t of live.filter((t) => t.state === "declined")) {
    (declined.get(t.unitId) ?? declined.set(t.unitId, new Set()).get(t.unitId)!).add(t.to);
  }

  const units = stock.sites.flatMap((s) => s.units);
  let modelNotice: string | undefined;
  let modelFailed = false;
  const input = {
    now,
    units,
    demand: buildDemand(usage),
    // A slot held by a live transfer isn't free, even before the courier books it at accept
    slots: stock.courier.slots.filter((slot) => !live.some((t) => ACTIVE.includes(t.state) && t.slotId === slot.slotId)),
    policies: SITE_POLICIES,
    transferredUnitIds: new Set(live.filter((t) => MOVED.includes(t.state)).map((t) => t.unitId)),
    activeUnitIds: new Set(live.filter((t) => ACTIVE.includes(t.state)).map((t) => t.unitId)),
    declined,
  };
  // The model picks per unit among that unit's ranked, rule-approved candidates.
  // buildPlan is synchronous, so choices are made up front. BR-009 is enforced inside buildPlan.
  const choices = new Map<string, Candidate | undefined>();
  if (messenger.name !== "template") {
    const byUnit = new Map<string, Candidate[]>();
    for (const c of buildCandidates(input).candidates) (byUnit.get(c.unitId) ?? byUnit.set(c.unitId, []).get(c.unitId)!).push(c);
    try {
      for (const [unitId, options] of byUnit) choices.set(unitId, await messenger.choose(rankCandidates(options)));
    } catch {
      modelFailed = true;
      choices.clear();
    }
  }
  // A model pick whose slot was taken by an earlier unit isn't in options, so BR-009 falls back
  const plan = buildPlan(input, (options) => (options[0] && choices.get(options[0].unitId)) ?? options[0]);
  assertLiveUnits(plan.transfers, units);

  const planId = `P-${now.toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${randomUUID().slice(0, 4)}`;
  const records: TransferRecord[] = [];
  let usedModel: "nemotron" | "template" = messenger.name === "nemotron" && !modelFailed ? "nemotron" : "template";
  for (const t of plan.transfers) {
    let message: string;
    let by: "nemotron" | "template" = usedModel;
    try {
      message = usedModel === "nemotron" ? await messenger.write(t) : await templateMessenger.write(t);
    } catch {
      modelFailed = true;
      usedModel = "template";
      by = "template";
      message = await templateMessenger.write(t);
    }
    const site = stock.sites.find((s) => s.site.id === t.from)!;
    records.push(
      await store.create(
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
          message,
          messageBy: by,
          evidence: {
            source: t.unit.source,
            queriedAt: site.status.ok ? site.status.queriedAt : now.toISOString(),
            status: t.unit.status,
            expiresAt: t.unit.expiresAt,
          },
        },
        "planner",
      ),
    );
  }
  if (messenger.name === "template") modelNotice = "Nemotron isn't configured. Requests use the standard template.";
  else if (modelFailed) modelNotice = "Nemotron didn't respond with valid output. Requests use the standard template.";

  const rejectionsByRule: Record<string, number> = {};
  for (const r of plan.rejections) rejectionsByRule[r.rule] = (rejectionsByRule[r.rule] ?? 0) + 1;
  return {
    planId,
    ranAt: now.toISOString(),
    model: modelFailed || messenger.name === "template" ? "template" : "nemotron",
    modelNotice,
    outdatesBefore: plan.outdatesBefore,
    outdatesAfter: plan.outdatesAfter,
    candidatesConsidered: plan.candidatesConsidered,
    rejectionsByRule,
    transfers: records,
  };
}

// Coordinator sends every proposal from the current plan to the receiving sites' inboxes
export async function sendProposals(store: TransferStore, by: string): Promise<TransferRecord[]> {
  const sent: TransferRecord[] = [];
  for (const t of store.list().filter((t) => t.state === "proposed")) {
    sent.push(await store.transition(t.id, "requested", by));
  }
  return sent;
}
