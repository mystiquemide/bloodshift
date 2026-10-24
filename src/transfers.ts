// Transfer state and history, kept in the Meterless World Model event log.
// Each transfer is an entity. Each state change is a fact with provenance, so the
// full history replays from the log after a refresh or restart.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { SiteId } from "./sites.js";

export type TransferState =
  | "proposed" | "superseded" | "requested" | "checking" | "reserved"
  | "refused" | "declined" | "failed" | "dispatched" | "received" | "cancelled";

// The state model from the plan. Superseded covers a proposal replaced by a newer plan run
// before it was sent.
const NEXT: Record<TransferState, TransferState[]> = {
  proposed: ["requested", "superseded"],
  superseded: [],
  requested: ["checking", "declined"],
  checking: ["reserved", "refused", "failed"],
  failed: ["checking"],
  reserved: ["dispatched", "cancelled"],
  dispatched: ["received"],
  refused: [],
  declined: [],
  received: [],
  cancelled: [],
};

// States in which the unit is spoken for (BR-010)
export const ACTIVE: TransferState[] = ["proposed", "requested", "checking", "failed", "reserved", "dispatched"];
// States in which the unit has physically moved or been committed to move (BR-006)
export const MOVED: TransferState[] = ["reserved", "dispatched", "received"];

export interface SourceEvidence {
  source: string;
  queriedAt: string;
  status: string;
  expiresAt: string;
}

export interface TransferRecord {
  id: string;
  planId: string;
  unitId: string;
  from: SiteId;
  to: SiteId;
  slotId: string;
  arrivesAt: string;
  abo: string;
  rh: string;
  irradiated: boolean;
  message: string;
  messageBy: "template" | "nemotron";
  evidence: SourceEvidence;
  state: TransferState;
  reason?: string;
  // Live source read at accept time, the evidence for a refusal or a reservation
  check?: SourceSnapshot;
  bookingId?: string;
  // The Zetaris read after the writes, showing the reservation and the booking
  confirmation?: SourceSnapshot | null;
  updatedAt: string;
}

export interface SourceSnapshot {
  queriedAt: string;
  unitStatus: string | null;
  reservedFor: string | null;
  expiresAt: string | null;
  unitUpdatedAt: string | null;
  slotStatus: string | null;
  bookingId: string | null;
}

export interface HistoryEntry {
  state: TransferState;
  at: string;
  by: string;
  reason?: string;
}

// The parts of the vendored World Model this module uses
interface Provenance { kind: string; by?: string; at: string; runId?: string }
interface WMEntity { id: string; type: string; attrs: Record<string, unknown> }
interface WMFact { about: string; predicate: string; value: unknown; source: Provenance; assertedAt: string }
interface WorldModelApi {
  upsertEntity(input: { type: string; externalKey: { system: string; id: string }; name: string; attrs: Record<string, unknown>; source: Provenance; state?: string }): Promise<WMEntity>;
  assertFact(input: { about: string; predicate: string; value: unknown; confidence?: number; source: Provenance }): Promise<WMFact>;
  view(name: "graph"): { query(opts: { type?: string }): WMEntity[]; entity(id: string): WMEntity | undefined };
  view(name: "facts"): { about(id: string): WMFact[] };
}

export class InvalidTransition extends Error {
  constructor(readonly from: TransferState, readonly to: TransferState, id: string) {
    super(`Transfer ${id} can't go from ${from} to ${to}`);
    this.name = "InvalidTransition";
  }
}

export class TransferStore {
  private constructor(private readonly wm: WorldModelApi, private readonly clock: () => Date) {}

  // Replays the log from disk. Throws if it can't, so the app refuses to start on a broken log.
  static async open(opts: { directory: string; namespace?: string; clock?: () => Date; storage?: "local" | "memory" }): Promise<TransferStore> {
    const directory = resolve(opts.directory);
    mkdirSync(directory, { recursive: true });
    const path = new URL("../vendor/meterless-world-model/index.ts", import.meta.url).href;
    const mod = (await import(path)) as { WorldModel: new (o: object) => WorldModelApi };
    const wm = new mod.WorldModel({
      namespace: opts.namespace ?? "bloodshift",
      storage: opts.storage ?? "local",
      directory,
      conflictPolicy: "most-recent-wins",
    });
    return new TransferStore(wm, opts.clock ?? (() => new Date()));
  }

  // Wall-clock times can collide at millisecond resolution. Facts need strictly increasing
  // timestamps so most-recent-wins picks the right state.
  private lastAt = 0;
  private now(): string {
    const t = Math.max(this.clock().getTime(), this.lastAt + 1);
    this.lastAt = t;
    return new Date(t).toISOString();
  }

  async create(t: Omit<TransferRecord, "state" | "updatedAt">, by: string): Promise<TransferRecord> {
    const at = this.now();
    const source = { kind: "pipeline", by, at, runId: t.planId };
    const { id, ...attrs } = t;
    await this.wm.upsertEntity({ type: "transfer", externalKey: { system: "bloodshift", id }, name: id, attrs: { ...attrs, transferId: id }, source });
    await this.wm.assertFact({ about: this.entityId(id), predicate: "state", value: "proposed", confidence: 1, source });
    return this.get(id)!;
  }

  async transition(id: string, to: TransferState, by: string, reason?: string, extra: Record<string, unknown> = {}): Promise<TransferRecord> {
    const current = this.get(id);
    if (!current) throw new Error(`No transfer ${id}`);
    if (!NEXT[current.state].includes(to)) throw new InvalidTransition(current.state, to, id);
    const source = { kind: "manual", by, at: this.now() };
    for (const [predicate, value] of Object.entries(extra)) {
      await this.wm.assertFact({ about: this.entityId(id), predicate, value, confidence: 1, source });
    }
    await this.wm.assertFact({ about: this.entityId(id), predicate: "state", value: to, confidence: 1, source });
    await this.wm.assertFact({ about: this.entityId(id), predicate: "reason", value: reason ?? "", confidence: 1, source });
    return this.get(id)!;
  }

  get(id: string): TransferRecord | undefined {
    const e = this.wm.view("graph").entity(this.entityId(id));
    return e ? this.toRecord(e) : undefined;
  }

  list(): TransferRecord[] {
    return this.wm
      .view("graph")
      .query({ type: "transfer" })
      .map((e) => this.toRecord(e))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  }

  history(id: string): HistoryEntry[] {
    const facts = this.wm.view("facts").about(this.entityId(id));
    const reasons = new Map(facts.filter((f) => f.predicate === "reason").map((f) => [f.assertedAt, String(f.value)]));
    return facts
      .filter((f) => f.predicate === "state")
      .sort((a, b) => a.assertedAt.localeCompare(b.assertedAt))
      .map((f) => ({ state: f.value as TransferState, at: f.assertedAt, by: f.source.by ?? "system", reason: reasons.get(f.assertedAt) || undefined }));
  }

  private entityId(id: string): string {
    return `transfer:bloodshift:${id}`;
  }

  // The reference World Model restores facts on replay but not the values folded onto the
  // entity, so current values come from the latest fact, which is right both live and after a restart.
  private latest(id: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const facts = [...this.wm.view("facts").about(this.entityId(id))].sort((a, b) => a.assertedAt.localeCompare(b.assertedAt));
    for (const f of facts) out[f.predicate] = f.value;
    return out;
  }

  private toRecord(e: WMEntity): TransferRecord {
    const id = String(e.attrs.transferId);
    const a = { ...e.attrs, ...this.latest(id) };
    const states = this.history(id);
    return {
      id: String(a.transferId),
      planId: String(a.planId),
      unitId: String(a.unitId),
      from: a.from as SiteId,
      to: a.to as SiteId,
      slotId: String(a.slotId),
      arrivesAt: String(a.arrivesAt),
      abo: String(a.abo),
      rh: String(a.rh),
      irradiated: Boolean(a.irradiated),
      message: String(a.message),
      messageBy: a.messageBy === "nemotron" ? "nemotron" : "template",
      evidence: a.evidence as SourceEvidence,
      state: a.state as TransferState,
      reason: typeof a.reason === "string" && a.reason ? a.reason : undefined,
      check: (a.check as SourceSnapshot | undefined) ?? undefined,
      bookingId: typeof a.bookingId === "string" ? a.bookingId : undefined,
      confirmation: (a.confirmation as SourceSnapshot | null | undefined) ?? undefined,
      updatedAt: states.at(-1)?.at ?? "",
    };
  }
}
