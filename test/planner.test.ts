import { describe, expect, it } from "vitest";
import { PlanAborted, runPlan, sendProposals, templateMessenger, type Messenger } from "../src/planner.js";
import { TransferStore } from "../src/transfers.js";
import type { Querier } from "../src/stock.js";
import type { QueryResult } from "../src/zetaris.js";

const NOW = new Date("2026-10-24T12:00:00Z");
const h = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString().replace("T", " ").replace("Z", "");

const res = (rows: QueryResult["rows"]): QueryResult => ({ rows, queriedAt: NOW.toISOString(), engineMs: 1 });

// Site A holds four O+ units it can't use in time. Site B uses O+ fast. Courier runs A to B.
function zetaris(opts: { down?: string; extraUnits?: number } = {}): Querier {
  return {
    query: async (sql) => {
      if (opts.down && sql.includes(opts.down)) throw new Error("source offline");
      if (sql.includes("usage_history")) {
        if (sql.includes("bs_site_a")) return res([{ site_id: "SITE_A", abo: "O", rh: "+", days: 30, used: 30 }]);
        if (sql.includes("bs_site_b")) return res([{ site_id: "SITE_B", abo: "O", rh: "+", days: 30, used: 300 }]);
        return res([]);
      }
      if (sql.includes("bs_courier")) {
        return res([1, 2, 3, 4].map((n) => ({ slot_id: `S-${n}`, from_site: "SITE_A", to_site: "SITE_B", departs_at: h(n), arrives_at: h(n + 2), status: "open", booking_id: "" })));
      }
      if (sql.includes("bs_site_a")) {
        const expiries = [30, 40, 50, 60, 70, ...Array.from({ length: opts.extraUnits ?? 0 }, (_, i) => 80 + i * 10)];
        return res(expiries.map((e, i) => ({ unit_id: `U-A-${i}`, site_id: "SITE_A", abo: "O", rh: "+", irradiated: "false", expires_at: h(e), status: "available", reserved_for: "" })));
      }
      return res([]);
    },
  };
}

const memoryStore = () => TransferStore.open({ directory: ".", storage: "memory", clock: () => NOW });

describe("runPlan", () => {
  it("proposes transfers citing live source rows, with the model-down notice", async () => {
    const store = await memoryStore();
    const run = await runPlan(zetaris(), store, templateMessenger, NOW);
    expect(run.transfers.length).toBeGreaterThan(0);
    expect(run.model).toBe("template");
    expect(run.modelNotice).toMatch(/isn't configured/);
    for (const t of run.transfers) {
      expect(t.state).toBe("proposed");
      expect(t.evidence.status).toBe("available");
      expect(t.evidence.source).toContain("bs_site_a");
    }
    expect(run.outdatesAfter).toBeLessThan(run.outdatesBefore);
  });

  it("refuses to plan over a partial network instead of using stale data", async () => {
    const store = await memoryStore();
    await expect(runPlan(zetaris({ down: "bs_site_b" }), store, templateMessenger, NOW)).rejects.toBeInstanceOf(PlanAborted);
    expect(store.list()).toEqual([]);
  });

  it("supersedes unsent proposals", async () => {
    const store = await memoryStore();
    const first = await runPlan(zetaris(), store, templateMessenger, NOW);
    await runPlan(zetaris(), store, templateMessenger, NOW);
    expect(first.transfers.every((t) => store.get(t.id)!.state === "superseded")).toBe(true);
  });

  it("never reuses a unit or courier slot held by a sent request", async () => {
    const store = await memoryStore();
    const first = await runPlan(zetaris(), store, templateMessenger, NOW);
    await sendProposals(store, "coordinator");
    // New stock arrives at Site A after the requests went out
    const second = await runPlan(zetaris({ extraUnits: 3 }), store, templateMessenger, NOW);
    const held = new Set(first.transfers.map((t) => t.slotId));
    expect(first.transfers.length).toBeGreaterThan(0);
    for (const t of second.transfers) {
      expect(held.has(t.slotId)).toBe(false);
      expect(first.transfers.some((f) => f.unitId === t.unitId)).toBe(false);
    }
  });

  it("falls back to the template when the model fails, and marks the plan", async () => {
    const broken: Messenger = { name: "nemotron", choose: async () => { throw new Error("timeout"); }, write: async () => { throw new Error("timeout"); } };
    const run = await runPlan(zetaris(), await memoryStore(), broken, NOW);
    expect(run.transfers.length).toBeGreaterThan(0);
    expect(run.model).toBe("template");
    expect(run.modelNotice).toMatch(/didn't respond/);
    expect(run.transfers.every((t) => t.messageBy === "template")).toBe(true);
  });

  it("ignores a model that names a unit outside the candidate set", async () => {
    const liar: Messenger = {
      name: "nemotron",
      choose: async (options) => ({ ...options[0]!, id: "C-U-FAKE", unitId: "U-FAKE" }),
      write: async (t) => `Model text for ${t.unitId}`,
    };
    const run = await runPlan(zetaris(), await memoryStore(), liar, NOW);
    expect(run.transfers.some((t) => t.unitId === "U-FAKE")).toBe(false);
    expect(run.transfers.length).toBeGreaterThan(0);
    expect(run.model).toBe("nemotron");
  });
});
