// The sending hospital's own record, without Zetaris in the way.
// readDirect gives Proof a second, independent read of the row. markUsed is a demo control that
// does what the hospital's lab system would do when it issues a unit locally, so anyone can
// watch an accept get refused. Neither touches Bloodshift's own transfer state.
import { SITES } from "./sites.js";
import type { DirectRow, SiteWriter } from "./siteWriters.js";
import type { TransferStore } from "./transfers.js";
import type { SiteId } from "./sites.js";

export interface SourceDeps {
  store: TransferStore;
  writers: Record<SiteId, SiteWriter>;
  now?: () => Date;
}

export class SourceError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
    this.name = "SourceError";
  }
}

export interface DirectRead {
  site: SiteId;
  system: string;
  unitId: string;
  readAt: string;
  row: DirectRow | null;
}

function transferOf(deps: SourceDeps, id: string) {
  const t = deps.store.get(id);
  if (!t) throw new SourceError("No such transfer", 404);
  return t;
}

export async function readSourceDirect(deps: SourceDeps, id: string): Promise<DirectRead> {
  const t = transferOf(deps, id);
  const row = await deps.writers[t.from].readDirect(t.unitId);
  return { site: t.from, system: SITES.find((s) => s.id === t.from)?.system ?? t.from, unitId: t.unitId, readAt: (deps.now?.() ?? new Date()).toISOString(), row };
}

// Only for a request still waiting on the lab, so it can't undo a reservation or a booking
export async function markSourceUsed(deps: SourceDeps, id: string): Promise<DirectRead> {
  const t = transferOf(deps, id);
  if (t.state !== "requested") throw new SourceError("Only a request waiting on the lab can be changed at its source", 409);
  const res = await deps.writers[t.from].markUsed(t.unitId);
  if (!res.ok) throw new SourceError(`Not changed: ${res.reason}`, 409);
  return readSourceDirect(deps, id);
}
