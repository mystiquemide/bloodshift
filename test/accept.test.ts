import { describe, expect, it } from "vitest";
import { AcceptError, acceptTransfer, type AcceptDeps } from "../src/accept.js";
import { TransferStore } from "../src/transfers.js";
import type { CourierClient, BookingResult } from "../src/courier.js";
import type { ReserveResult, SiteWriter } from "../src/siteWriters.js";
import type { Querier } from "../src/stock.js";
import type { SiteId } from "../src/sites.js";

const NOW = new Date("2026-10-24T12:00:00Z");

interface World {
  unit: { status: string; reserved_for: string | null; expires_at: string };
  slot: { status: string; booking_id: string };
  zetarisDown?: boolean;
}

function world(over: Partial<World> = {}): World {
  return {
    unit: { status: "available", reserved_for: null, expires_at: "2026-10-26 00:00:00.0" },
    slot: { status: "open", booking_id: "" },
    ...over,
  };
}

function zetarisOver(w: World): Querier {
  return {
    query: async (sql) => {
      if (w.zetarisDown) throw new Error("Zetaris unreachable");
      // One federated statement returns the unit row and the slot row joined
      const rows = [{
        unit_id: "U-A-1", ...w.unit, updated_at: "2026-10-24 09:14:00.0",
        slot_id: "S-01", slot_status: w.slot.status, booking_id: w.slot.booking_id,
      }];
      return { rows, queriedAt: NOW.toISOString(), engineMs: 1 };
    },
  };
}

// A sending site whose own table is the World's unit row
class FakeWriter implements SiteWriter {
  calls: string[] = [];
  constructor(private w: World, private fail: "none" | "throw" | "changed" = "none") {}
  async reserve(_id: string, forSite: SiteId): Promise<ReserveResult> {
    this.calls.push("reserve");
    if (this.fail === "throw") throw new Error("connection reset");
    if (this.fail === "changed") return { ok: false, reason: "the unit is now used" };
    this.w.unit = { ...this.w.unit, status: "reserved", reserved_for: forSite };
    return { ok: true };
  }
  async release(_id: string, forSite: SiteId): Promise<void> {
    this.calls.push("release");
    if (this.w.unit.status === "reserved" && this.w.unit.reserved_for === forSite) this.w.unit = { ...this.w.unit, status: "available", reserved_for: null };
  }
}

function courierWith(w: World, results: BookingResult[]): CourierClient & { calls: number } {
  const c = {
    calls: 0,
    book: async () => {
      c.calls++;
      const r = results.shift() ?? { ok: true, bookingId: "BK-1" };
      if (r.ok) w.slot = { status: "booked", booking_id: r.bookingId };
      return r;
    },
    cancel: async () => undefined,
  };
  return c as unknown as CourierClient & { calls: number };
}

async function setup(w: World, opts: { writer?: FakeWriter; courier?: BookingResult[] } = {}) {
  const store = await TransferStore.open({ directory: ".", storage: "memory", clock: () => NOW });
  await store.create({
    id: "T-1", planId: "P-1", unitId: "U-A-1", from: "SITE_A", to: "SITE_B", slotId: "S-01",
    arrivesAt: "2026-10-24T16:00:00.000Z", abo: "O", rh: "+", irradiated: false, message: "m", messageBy: "template",
    evidence: { source: "s", queriedAt: NOW.toISOString(), status: "available", expiresAt: "2026-10-26T00:00:00.000Z" },
  }, "planner");
  await store.transition("T-1", "requested", "coordinator");
  const writer = opts.writer ?? new FakeWriter(w);
  const courier = courierWith(w, opts.courier ?? []);
  const deps: AcceptDeps = { zetaris: zetarisOver(w), store, writers: { SITE_A: writer, SITE_B: writer, SITE_C: writer }, courier, now: () => NOW };
  return { store, writer, courier, deps };
}

describe("accept", () => {
  it("reserves at the source and books the courier when the live row is unchanged", async () => {
    const w = world();
    const { deps, courier } = await setup(w);
    const t = await acceptTransfer(deps, "T-1", "SITE_B");
    expect(t.state).toBe("reserved");
    expect(t.bookingId).toBe("BK-1");
    expect(w.unit).toMatchObject({ status: "reserved", reserved_for: "SITE_B" });
    expect(t.confirmation).toMatchObject({ unitStatus: "reserved", reservedFor: "SITE_B", slotStatus: "booked" });
    expect(courier.calls).toBe(1);
  });

  it("refuses a unit marked used at the source, and writes nothing (BR-003)", async () => {
    const w = world({ unit: { status: "used", reserved_for: null, expires_at: "2026-10-26 00:00:00.0" } });
    const { deps, writer, courier } = await setup(w);
    const t = await acceptTransfer(deps, "T-1", "SITE_B");
    expect(t.state).toBe("refused");
    expect(t.reason).toBe("Northgate General reports this unit used at 09:14 UTC");
    expect(t.check?.unitStatus).toBe("used");
    expect(writer.calls).toEqual([]);
    expect(courier.calls).toBe(0);
  });

  it("refuses an expired unit and a slot the courier no longer offers", async () => {
    const expired = await setup(world({ unit: { status: "available", reserved_for: null, expires_at: "2026-10-24 11:00:00.0" } }));
    expect((await acceptTransfer(expired.deps, "T-1", "SITE_B")).reason).toMatch(/expired/);
    const cancelled = await setup(world({ slot: { status: "cancelled", booking_id: "" } }));
    expect((await acceptTransfer(cancelled.deps, "T-1", "SITE_B")).reason).toMatch(/cancelled/);
  });

  it("re-checks the unit and slot in one federated statement, and names a slot that's gone", async () => {
    const { deps, writer } = await setup(world());
    const seen: string[] = [];
    deps.zetaris = { query: async (sql) => {
      seen.push(sql);
      // The courier no longer has the slot: the outer join returns the unit side only
      return { rows: [{ unit_id: "U-A-1", status: "available", reserved_for: null, expires_at: "2026-10-26 00:00:00.0", updated_at: "2026-10-24 09:14:00.0", slot_id: null, slot_status: null, booking_id: null }], queriedAt: NOW.toISOString(), engineMs: 1 };
    } };
    const t = await acceptTransfer(deps, "T-1", "SITE_B");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/bs_site_a\.platelet_units.*FULL OUTER JOIN.*bs_courier\.slots/);
    expect(t.state).toBe("refused");
    expect(t.reason).toMatch(/no longer lists slot S-01/);
    expect(writer.calls).toEqual([]);
  });

  it("refuses when the row changes between the Zetaris read and the write", async () => {
    const w = world();
    const { deps, courier } = await setup(w, { writer: new FakeWriter(w, "changed") });
    const t = await acceptTransfer(deps, "T-1", "SITE_B");
    expect(t.state).toBe("refused");
    expect(t.reason).toMatch(/now used/);
    expect(courier.calls).toBe(0);
  });

  it("fails without writing when Zetaris can't be reached, and retries cleanly", async () => {
    const w = world({ zetarisDown: true });
    const { deps, writer } = await setup(w);
    const failed = await acceptTransfer(deps, "T-1", "SITE_B");
    expect(failed.state).toBe("failed");
    expect(writer.calls).toEqual([]);
    w.zetarisDown = false;
    expect((await acceptTransfer(deps, "T-1", "SITE_B")).state).toBe("reserved");
  });

  it("releases the reservation when the courier fails, then succeeds on retry", async () => {
    const w = world();
    const { deps, writer, courier } = await setup(w, { courier: [{ ok: false, reason: "The courier service didn't respond", retryable: true }] });
    const failed = await acceptTransfer(deps, "T-1", "SITE_B");
    expect(failed.state).toBe("failed");
    expect(w.unit.status).toBe("available");
    expect(writer.calls).toEqual(["reserve", "release"]);
    const retried = await acceptTransfer(deps, "T-1", "SITE_B");
    expect(retried.state).toBe("reserved");
    expect(courier.calls).toBe(2);
  });

  it("refuses and releases when the slot was taken by someone else", async () => {
    const w = world();
    const { deps } = await setup(w, { courier: [{ ok: false, reason: "Slot S-01 is booked", retryable: false }] });
    const t = await acceptTransfer(deps, "T-1", "SITE_B");
    expect(t.state).toBe("refused");
    expect(w.unit.status).toBe("available");
  });

  it("fails and releases after a write error at the source", async () => {
    const w = world();
    const { deps, writer } = await setup(w, { writer: new FakeWriter(w, "throw") });
    const t = await acceptTransfer(deps, "T-1", "SITE_B");
    expect(t.state).toBe("failed");
    expect(writer.calls).toEqual(["reserve", "release"]);
  });

  it("books once when accept is double-clicked", async () => {
    const w = world();
    const { deps, courier, store } = await setup(w);
    await Promise.all([acceptTransfer(deps, "T-1", "SITE_B"), acceptTransfer(deps, "T-1", "SITE_B")]);
    await acceptTransfer(deps, "T-1", "SITE_B");
    expect(courier.calls).toBe(1);
    expect(store.get("T-1")!.state).toBe("reserved");
  });

  it("lets only the receiving site accept, and only from an acceptable state", async () => {
    const w = world();
    const { deps, store } = await setup(w);
    await expect(acceptTransfer(deps, "T-1", "SITE_C")).rejects.toMatchObject({ status: 403 });
    await store.transition("T-1", "declined", "SITE_B", "no demand");
    await expect(acceptTransfer(deps, "T-1", "SITE_B")).rejects.toBeInstanceOf(AcceptError);
  });

  it("rejects malformed IDs before they reach SQL", async () => {
    const w = world();
    const { deps, store } = await setup(w);
    await store.create({ ...store.get("T-1")!, id: "T-2", unitId: "U-1' OR '1'='1" }, "planner");
    await store.transition("T-2", "requested", "coordinator");
    await expect(acceptTransfer(deps, "T-2", "SITE_B")).rejects.toMatchObject({ status: 400 });
    expect(store.get("T-2")!.state).toBe("requested");
  });
});
