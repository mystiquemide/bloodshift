// Accept: no live row, no move.
// The receiving site accepts. The app re-reads the unit and the courier slot through Zetaris,
// refuses if either changed, then reserves the unit in the sending site's own system and books
// the courier. If the booking fails, the reservation is released, so nothing is left half done.
import { COURIER_SOURCE, SITES, type SiteId } from "./sites.js";
import { isoTime, type Querier } from "./stock.js";
import { USE_WINDOW_HOURS } from "./rules.js";
import type { CourierClient } from "./courier.js";
import type { SiteWriter } from "./siteWriters.js";
import type { SourceSnapshot, TransferRecord, TransferStore } from "./transfers.js";

export interface AcceptDeps {
  zetaris: Querier;
  store: TransferStore;
  writers: Record<SiteId, SiteWriter>;
  courier: CourierClient;
  now?: () => Date;
}

export class AcceptError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message);
    this.name = "AcceptError";
  }
}

export type SourceCheck = SourceSnapshot;

const ID = /^[A-Z0-9-]{1,40}$/;
const inFlight = new Set<string>();

function sourceOf(site: SiteId): string {
  const s = SITES.find((x) => x.id === site);
  if (!s) throw new Error(`Unknown site ${site}`);
  return s.zetarisSource;
}

function siteName(id: SiteId): string {
  return SITES.find((s) => s.id === id)?.name ?? id;
}

// Re-reads the unit and slot live through Zetaris. Ids are checked against a strict pattern
// before they go into SQL, since the Zetaris HTTP API takes no bind parameters.
export async function readSource(zetaris: Querier, t: Pick<TransferRecord, "unitId" | "from" | "slotId">): Promise<SourceCheck> {
  if (!ID.test(t.unitId) || !ID.test(t.slotId)) throw new AcceptError("Malformed unit or slot ID", 400);
  const sql = [
    `SELECT unit_id, status, reserved_for, expires_at, updated_at FROM ${sourceOf(t.from)}.platelet_units WHERE unit_id = '${t.unitId}'`,
    `SELECT slot_id, status, booking_id FROM ${COURIER_SOURCE}.slots WHERE slot_id = '${t.slotId}'`,
  ];
  const [unit, slot] = await Promise.all(sql.map((q) => zetaris.query(q)));
  const u = unit!.rows[0];
  const s = slot!.rows[0];
  const text = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" || v === "null" ? null : String(v));
  return {
    sql,
    queriedAt: unit!.queriedAt,
    unitStatus: u ? text(u.status) : null,
    reservedFor: u ? text(u.reserved_for) : null,
    expiresAt: u && text(u.expires_at) ? isoTime(u.expires_at) : null,
    unitUpdatedAt: u && text(u.updated_at) ? isoTime(u.updated_at) : null,
    slotStatus: s ? text(s.status) : null,
    bookingId: s ? text(s.booking_id) : null,
  };
}

// Returns a refusal reason, or null when the live rows still allow the move (BR-003)
export function checkLive(t: TransferRecord, live: SourceCheck, now: Date): string | null {
  const from = siteName(t.from);
  const when = live.unitUpdatedAt ? ` at ${live.unitUpdatedAt.slice(11, 16)} UTC` : "";
  if (live.unitStatus === null) return `${from} no longer lists unit ${t.unitId}`;
  const ours = live.unitStatus === "reserved" && live.reservedFor === t.to;
  if (!ours && (live.unitStatus !== "available" || live.reservedFor)) {
    return `${from} reports this unit ${live.unitStatus}${live.reservedFor ? ` for ${live.reservedFor}` : ""}${when}`;
  }
  if (!live.expiresAt || Date.parse(live.expiresAt) <= now.getTime()) return `${from} reports this unit expired`;
  const leftOnArrival = (Date.parse(live.expiresAt) - Date.parse(t.arrivesAt)) / 3_600_000;
  if (leftOnArrival < USE_WINDOW_HOURS) return `The unit would arrive with ${leftOnArrival.toFixed(1)}h left, under the ${USE_WINDOW_HOURS}h use window`;
  if (live.slotStatus === null) return `The courier no longer lists slot ${t.slotId}`;
  if (live.slotStatus !== "open" && live.slotStatus !== "booked") return `Courier slot ${t.slotId} is ${live.slotStatus}`;
  return null;
}

export async function acceptTransfer(deps: AcceptDeps, id: string, actingSite: SiteId): Promise<TransferRecord> {
  const { store, zetaris, writers, courier } = deps;
  const now = deps.now ?? (() => new Date());
  const t = store.get(id);
  if (!t) throw new AcceptError("No such transfer", 404);
  if (t.to !== actingSite) throw new AcceptError(`Only ${siteName(t.to)} can accept this transfer`, 403);
  if (!ID.test(t.unitId) || !ID.test(t.slotId)) throw new AcceptError("Malformed unit or slot ID", 400);
  // A double click, or a retry racing the first attempt, returns the transfer as it stands
  if (t.state === "reserved" || inFlight.has(id)) return t;
  if (t.state !== "requested" && t.state !== "failed" && t.state !== "checking") {
    throw new AcceptError(`This transfer is ${t.state} and can't be accepted`, 409);
  }

  inFlight.add(id);
  try {
    // "checking" left over from a crash is resumed. Every write below is safe to repeat.
    if (t.state !== "checking") await store.transition(id, "checking", actingSite);

    let live: SourceCheck;
    try {
      live = await readSource(zetaris, t);
    } catch (err) {
      if (err instanceof AcceptError) throw err;
      return store.transition(id, "failed", "system", "Couldn't re-read the source through Zetaris. Nothing was written. Retry when it's reachable.");
    }
    const refusal = checkLive(t, live, now());
    if (refusal) return store.transition(id, "refused", "system", refusal, { check: live });

    let reserved;
    try {
      reserved = await writers[t.from].reserve(t.unitId, t.to);
    } catch (err) {
      console.error(`Reserve failed for ${id}:`, err);
      await writers[t.from].release(t.unitId, t.to).catch(() => undefined);
      return store.transition(id, "failed", "system", `Couldn't write to ${siteName(t.from)}'s system. Nothing was reserved. Retry.`, { check: live });
    }
    // The row changed between the Zetaris read and the write
    if (!reserved.ok) return store.transition(id, "refused", "system", `${siteName(t.from)} reports ${reserved.reason}`, { check: live });

    const booking = await courier.book(t.slotId, t.id);
    if (!booking.ok) {
      try {
        await writers[t.from].release(t.unitId, t.to);
      } catch (err) {
        console.error(`Release failed for ${id}:`, err);
        return store.transition(id, "failed", "system", `${booking.reason}. Releasing the reservation also failed, so ${siteName(t.from)} may still show it. Retry.`, { check: live });
      }
      return booking.retryable
        ? store.transition(id, "failed", "system", `${booking.reason}. The reservation was released. Retry.`, { check: live })
        : store.transition(id, "refused", "system", `${booking.reason}. The reservation was released.`, { check: live });
    }

    // Confirm through the same federated read the network view uses
    const confirmation = await readSource(zetaris, t).catch(() => null);
    return store.transition(id, "reserved", "system", undefined, { check: live, bookingId: booking.bookingId, confirmation });
  } finally {
    inFlight.delete(id);
  }
}
