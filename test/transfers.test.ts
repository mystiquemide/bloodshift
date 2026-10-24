import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InvalidTransition, TransferStore } from "../src/transfers.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "bs-wm-"));
  dirs.push(d);
  return d;
}

const base = {
  id: "T-1", planId: "P-1", unitId: "U-A-0101", from: "SITE_A" as const, to: "SITE_B" as const,
  slotId: "S-01", arrivesAt: "2026-10-24T21:00:00.000Z", abo: "O", rh: "+", irradiated: false,
  message: "Please accept", messageBy: "template" as const,
  evidence: { source: "Postgres via Zetaris", queriedAt: "2026-10-24T17:00:00.000Z", status: "available", expiresAt: "2026-10-26T00:00:00.000Z" },
};

describe("TransferStore", () => {
  it("records a proposal and its transitions with provenance", async () => {
    const store = await TransferStore.open({ directory: tmp(), storage: "memory" });
    await store.create(base, "planner");
    await store.transition("T-1", "requested", "coordinator");
    const t = store.get("T-1")!;
    expect(t.state).toBe("requested");
    expect(t.evidence.status).toBe("available");
    expect(store.history("T-1").map((h) => [h.state, h.by])).toEqual([["proposed", "planner"], ["requested", "coordinator"]]);
  });

  it("refuses transitions the state model doesn't allow", async () => {
    const store = await TransferStore.open({ directory: tmp(), storage: "memory" });
    await store.create(base, "planner");
    await expect(store.transition("T-1", "reserved", "x")).rejects.toBeInstanceOf(InvalidTransition);
    await store.transition("T-1", "requested", "x");
    await store.transition("T-1", "declined", "SITE_B", "No O+ demand this week");
    await expect(store.transition("T-1", "checking", "x")).rejects.toBeInstanceOf(InvalidTransition);
    expect(store.get("T-1")!.reason).toBe("No O+ demand this week");
  });

  it("keeps state and history across a restart", async () => {
    const dir = tmp();
    const first = await TransferStore.open({ directory: dir });
    await first.create(base, "planner");
    await first.transition("T-1", "requested", "coordinator");
    const reopened = await TransferStore.open({ directory: dir });
    expect(reopened.get("T-1")!.state).toBe("requested");
    expect(reopened.history("T-1")).toHaveLength(2);
  });

  it("orders same-millisecond transitions correctly", async () => {
    const fixed = new Date("2026-10-24T17:00:00Z");
    const store = await TransferStore.open({ directory: tmp(), storage: "memory", clock: () => fixed });
    await store.create(base, "planner");
    await store.transition("T-1", "requested", "x");
    await store.transition("T-1", "checking", "x");
    expect(store.get("T-1")!.state).toBe("checking");
  });
});
