// A receiving site declines a request with a reason. The reason goes to H-MEM with
// provenance, then the unit is replanned with that site excluded (BR-008).
import { AcceptError } from "./accept.js";
import { MAX_REASON } from "./declineMemory.js";
import { replan, type PlannerDeps, type Replan } from "./planner.js";
import type { SiteId } from "./sites.js";

export async function declineTransfer(deps: PlannerDeps, id: string, site: SiteId, rawReason: unknown, now = new Date()): Promise<Replan> {
  const t = deps.store.get(id);
  if (!t) throw new AcceptError("No such transfer", 404);
  if (t.to !== site) throw new AcceptError("Only the receiving site can decline this transfer", 403);
  const reason = typeof rawReason === "string" ? rawReason.replace(/\s+/g, " ").trim() : "";
  if (!reason) throw new AcceptError("Give a reason for declining", 400);
  if (reason.length > MAX_REASON) throw new AcceptError(`Keep the reason under ${MAX_REASON} characters`, 400);
  if (t.state === "declined") return replan(deps, id, now);
  if (t.state !== "requested") throw new AcceptError(`This transfer is ${t.state} and can't be declined`, 409);

  await deps.store.transition(id, "declined", site, reason);
  deps.memory.record({ site, unitId: t.unitId, group: `${t.abo}${t.rh}`, transferId: id, reason, by: site });
  return replan(deps, id, now);
}
