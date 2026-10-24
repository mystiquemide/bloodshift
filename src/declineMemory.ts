// Decline reasons, kept in the Meterless H-MEM store with provenance so later plans can
// weigh a site's past declines. Reasons are untrusted free text from a site's lab staff.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { SiteId } from "./sites.js";

export interface DeclineNote {
  memoryId: string;
  site: SiteId;
  unitId: string;
  group: string;
  transferId: string;
  reason: string;
  by: string;
  at: string;
}

interface MemoryRecord {
  id: string;
  content: string;
  timestamp: number;
  tags: string[];
  source: string;
  provenance: { origin: string; learnedAt: number; label: string; refs?: string[] };
}

interface HmemApi {
  add(input: { content: string; type?: string; tags?: string[]; confidence?: number; source: string; provenance?: MemoryRecord["provenance"] }): MemoryRecord;
  store: { all(): MemoryRecord[] };
}

// Long enough for a real reason, short enough to keep prompts and the UI bounded
export const MAX_REASON = 500;

export class DeclineMemory {
  private constructor(private readonly hmem: HmemApi) {}

  static async open(opts: { directory?: string; clock?: () => number }): Promise<DeclineMemory> {
    let persistDir: string | undefined;
    if (opts.directory) {
      persistDir = resolve(opts.directory, "hmem");
      mkdirSync(persistDir, { recursive: true });
    }
    const path = new URL("../vendor/meterless-hmem/index.ts", import.meta.url).href;
    const mod = (await import(path)) as { HMEM: new (o: object) => HmemApi };
    return new DeclineMemory(new mod.HMEM({ persistDir, clock: opts.clock, actor: "bloodshift" }));
  }

  record(note: Omit<DeclineNote, "memoryId" | "at">): DeclineNote {
    const reason = note.reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
    const rec = this.hmem.add({
      content: reason,
      type: "factual",
      tags: [`site:${note.site}`, `unit:${note.unitId}`, `group:${note.group}`, `transfer:${note.transferId}`, `by:${note.by}`],
      confidence: 0.9,
      source: "bloodshift-inbox-decline",
      provenance: { origin: "manual", learnedAt: Date.now(), label: `Declined in ${note.site} inbox`, refs: [note.transferId] },
    });
    return this.toNote(rec);
  }

  // A site's declines, newest first, read back with provenance
  forSite(site: SiteId, limit = 10): DeclineNote[] {
    return this.all().filter((n) => n.site === site).slice(0, limit);
  }

  all(): DeclineNote[] {
    return this.hmem.store
      .all()
      .filter((r) => r.source === "bloodshift-inbox-decline")
      .map((r) => this.toNote(r))
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  private toNote(r: MemoryRecord): DeclineNote {
    const tag = (k: string) => r.tags.find((t) => t.startsWith(`${k}:`))?.slice(k.length + 1) ?? "";
    return {
      memoryId: r.id,
      site: tag("site") as SiteId,
      unitId: tag("unit"),
      group: tag("group"),
      transferId: tag("transfer"),
      reason: r.content,
      by: tag("by"),
      at: new Date(r.timestamp).toISOString(),
    };
  }
}
