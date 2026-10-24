// Writes go to each hospital's own system through narrow adapters, not through Zetaris.
// Hospitals keep write control. Zetaris only reads.
//
// Every write is conditional on the row still being available, so a change at the source
// between the Zetaris check and the write can't be overwritten.
import pg from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { optional, required } from "./config.js";
import type { SiteId } from "./sites.js";

const run = promisify(execFile);

export type ReserveResult = { ok: true } | { ok: false; reason: string };

export interface SiteWriter {
  reserve(unitId: string, forSite: SiteId): Promise<ReserveResult>;
  // Undoes a reservation this app made, used when the courier booking fails
  release(unitId: string, forSite: SiteId): Promise<void>;
}

export class PostgresWriter implements SiteWriter {
  constructor(private readonly pool: pg.Pool) {}

  static fromEnv(site: "SITE_A" | "SITE_B"): PostgresWriter {
    return new PostgresWriter(
      new pg.Pool({
        host: optional(`${site}_HOST`, "127.0.0.1"),
        port: Number(optional(`${site}_PORT`, site === "SITE_A" ? "5433" : "5434")),
        user: optional(`${site}_USER`, site.toLowerCase()),
        password: required(`${site}_PASSWORD`),
        database: site.toLowerCase(),
        max: 2,
      }),
    );
  }

  async reserve(unitId: string, forSite: SiteId): Promise<ReserveResult> {
    const res = await this.pool.query(
      `UPDATE platelet_units SET status = 'reserved', reserved_for = $2, updated_at = now()
       WHERE unit_id = $1 AND status = 'available' AND reserved_for IS NULL AND expires_at > now()`,
      [unitId, forSite],
    );
    if (res.rowCount === 1) return { ok: true };
    // Already reserved for this site by an earlier attempt of the same accept
    const row = await this.pool.query(`SELECT status, reserved_for FROM platelet_units WHERE unit_id = $1`, [unitId]);
    const r = row.rows[0] as { status: string; reserved_for: string | null } | undefined;
    if (r?.status === "reserved" && r.reserved_for === forSite) return { ok: true };
    return { ok: false, reason: r ? `the unit is now ${r.status}${r.reserved_for ? ` for ${r.reserved_for}` : ""}` : "the unit is no longer in its system" };
  }

  async release(unitId: string, forSite: SiteId): Promise<void> {
    await this.pool.query(
      `UPDATE platelet_units SET status = 'available', reserved_for = NULL, updated_at = now()
       WHERE unit_id = $1 AND status = 'reserved' AND reserved_for = $2`,
      [unitId, forSite],
    );
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

interface CsvRow {
  unit_id: string;
  status: string;
  reserved_for: string;
  expires_at: string;
  updated_at: string;
}

// Site C's system is a CSV export. The adapter rewrites it in place inside the Zetaris
// file root, swapping the file atomically. Writes are serialised within this app.
export class CsvWriter implements SiteWriter {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly container: string,
    private readonly path: string,
    private readonly exec: (args: string[], input?: string) => Promise<string> = async (args, input) => {
      if (input === undefined) return (await run("docker", args, { maxBuffer: 10_000_000 })).stdout;
      return new Promise((resolve, reject) => {
        const child = execFile("docker", args, { maxBuffer: 10_000_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
        child.stdin!.end(input);
      });
    },
  ) {}

  static fromEnv(): CsvWriter {
    const dir = optional("SITE_C_DIR", "/home/zetaris/customer-data/shared/bloodshift/site_c");
    return new CsvWriter(optional("ZETARIS_DRIVER_CONTAINER", "zetaris-driver-1"), `${dir}/units.csv`);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async update(change: (row: CsvRow) => "write" | "same" | string): Promise<ReserveResult> {
    const text = await this.exec(["exec", this.container, "cat", this.path]);
    const lines = text.trimEnd().split("\n");
    const header = lines[0]!.split(",");
    const col = (name: string) => {
      const i = header.indexOf(name);
      if (i < 0) throw new Error(`Site C CSV has no ${name} column`);
      return i;
    };
    const [iId, iStatus, iFor, iExp, iUpd] = ["unit_id", "status", "reserved_for", "expires_at", "updated_at"].map(col) as [number, number, number, number, number];
    let outcome: ReserveResult | null = null;
    const out = lines.map((line, n) => {
      if (n === 0) return line;
      const cells = line.split(",");
      const row: CsvRow = { unit_id: cells[iId] ?? "", status: cells[iStatus] ?? "", reserved_for: cells[iFor] ?? "", expires_at: cells[iExp] ?? "", updated_at: cells[iUpd] ?? "" };
      const verdict = outcome ? "same" : change(row);
      if (verdict === "same") return line;
      if (verdict !== "write") {
        outcome = { ok: false, reason: verdict };
        return line;
      }
      outcome = { ok: true };
      cells[iStatus] = row.status;
      cells[iFor] = row.reserved_for;
      cells[iUpd] = new Date().toISOString();
      return cells.join(",");
    });
    const result: ReserveResult = outcome ?? { ok: false, reason: "the unit is no longer in its system" };
    if (result.ok) {
      const tmp = `${this.path}.tmp`;
      await this.exec(["exec", "-i", this.container, "sh", "-c", `cat > '${tmp}' && mv '${tmp}' '${this.path}'`], out.join("\n") + "\n");
    }
    return result;
  }

  reserve(unitId: string, forSite: SiteId): Promise<ReserveResult> {
    return this.serial(() =>
      this.update((row) => {
        if (row.unit_id !== unitId) return "same";
        if (row.status === "reserved" && row.reserved_for === forSite) return "write";
        if (row.status !== "available" || row.reserved_for) return `the unit is now ${row.status}${row.reserved_for ? ` for ${row.reserved_for}` : ""}`;
        if (Date.parse(row.expires_at) <= Date.now()) return "the unit has expired";
        row.status = "reserved";
        row.reserved_for = forSite;
        return "write";
      }),
    );
  }

  async release(unitId: string, forSite: SiteId): Promise<void> {
    await this.serial(() =>
      this.update((row) => {
        if (row.unit_id !== unitId || row.status !== "reserved" || row.reserved_for !== forSite) return "same";
        row.status = "available";
        row.reserved_for = "";
        return "write";
      }),
    );
  }
}

export function siteWritersFromEnv(): Record<SiteId, SiteWriter> {
  return { SITE_A: PostgresWriter.fromEnv("SITE_A"), SITE_B: PostgresWriter.fromEnv("SITE_B"), SITE_C: CsvWriter.fromEnv() };
}
