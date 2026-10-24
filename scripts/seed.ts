// Seeds the three synthetic hospital sources and the mock courier from a fixed seed.
// Unit content is deterministic. Times are relative to the hour the seed runs,
// so expiries are always near-term during a demo.
import pg from "pg";
import { execFileSync } from "node:child_process";
import { loadEnv, optional, required } from "../src/config.js";
import { rng } from "../src/random.js";
import { BLOOD_GROUPS } from "../src/sites.js";

loadEnv();

interface SiteSeed {
  id: "SITE_A" | "SITE_B" | "SITE_C";
  prefix: string;
  units: number;
  dailyUse: number;
}

// Site A over-stocks for its usage, Site B runs short. That's the imbalance to fix.
const SITES: SiteSeed[] = [
  { id: "SITE_A", prefix: "U-A", units: 26, dailyUse: 2 },
  { id: "SITE_B", prefix: "U-B", units: 9, dailyUse: 6 },
  { id: "SITE_C", prefix: "U-C", units: 14, dailyUse: 3 },
];

export interface Unit {
  unit_id: string;
  site_id: string;
  abo: string;
  rh: string;
  irradiated: boolean;
  collected_at: string;
  expires_at: string;
  status: "available";
  reserved_for: null;
  updated_at: string;
}

export interface Usage {
  site_id: string;
  day: string;
  abo: string;
  rh: string;
  units_used: number;
}

function pickGroup(r: () => number): [string, string] {
  let x = r();
  for (const [abo, rh, share] of BLOOD_GROUPS) {
    if ((x -= share) <= 0) return [abo, rh];
  }
  return ["O", "+"];
}

export function generate(seed: number, now: Date): { units: Unit[]; usage: Usage[] } {
  const r = rng(seed);
  const anchor = new Date(now);
  anchor.setUTCMinutes(0, 0, 0);
  const hour = 3_600_000;
  const units: Unit[] = [];
  const usage: Usage[] = [];

  for (const site of SITES) {
    for (let i = 1; i <= site.units; i++) {
      const [abo, rh] = pickGroup(r);
      // Platelets last about 5 days from collection. Spread remaining life over 6 to 118 hours.
      const remaining = 6 + Math.floor(r() * 112);
      const expires = new Date(anchor.getTime() + remaining * hour);
      units.push({
        unit_id: `${site.prefix}-${String(100 + i).padStart(4, "0")}`,
        site_id: site.id,
        abo,
        rh,
        irradiated: r() < 0.3,
        collected_at: new Date(expires.getTime() - 120 * hour).toISOString(),
        expires_at: expires.toISOString(),
        status: "available",
        reserved_for: null,
        updated_at: anchor.toISOString(),
      });
    }
    for (let d = 30; d >= 1; d--) {
      const day = new Date(anchor.getTime() - d * 24 * hour).toISOString().slice(0, 10);
      for (const [abo, rh, share] of BLOOD_GROUPS) {
        const mean = site.dailyUse * share;
        // Integer usage with the right long-run mean
        const used = Math.floor(mean) + (r() < mean - Math.floor(mean) ? 1 : 0);
        usage.push({ site_id: site.id, day, abo, rh, units_used: used });
      }
    }
  }
  return { units, usage };
}

export function courierSlots(now: Date) {
  const anchor = new Date(now);
  anchor.setUTCMinutes(0, 0, 0);
  const hour = 3_600_000;
  const routes = [
    ["SITE_A", "SITE_B"], ["SITE_A", "SITE_C"], ["SITE_C", "SITE_B"],
    ["SITE_B", "SITE_A"], ["SITE_C", "SITE_A"], ["SITE_B", "SITE_C"],
  ];
  const slots = [];
  let n = 1;
  for (const offset of [2, 6, 10]) {
    for (const [from, to] of routes) {
      const departs = new Date(anchor.getTime() + offset * hour);
      slots.push({
        slot_id: `S-${String(n++).padStart(2, "0")}`,
        from_site: from,
        to_site: to,
        departs_at: departs.toISOString(),
        arrives_at: new Date(departs.getTime() + 2 * hour).toISOString(),
        status: "open",
        booking_id: "",
      });
    }
  }
  return slots;
}

const SCHEMA = `
DROP TABLE IF EXISTS platelet_units;
DROP TABLE IF EXISTS usage_history;
CREATE TABLE platelet_units (
  unit_id      text PRIMARY KEY,
  site_id      text NOT NULL,
  abo          text NOT NULL,
  rh           text NOT NULL,
  irradiated   boolean NOT NULL,
  collected_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  status       text NOT NULL CHECK (status IN ('available', 'reserved', 'used', 'expired')),
  reserved_for text,
  updated_at   timestamptz NOT NULL
);
CREATE TABLE usage_history (
  site_id    text NOT NULL,
  day        date NOT NULL,
  abo        text NOT NULL,
  rh         text NOT NULL,
  units_used integer NOT NULL,
  PRIMARY KEY (site_id, day, abo, rh)
);`;

async function seedPostgres(site: "SITE_A" | "SITE_B", units: Unit[], usage: Usage[]) {
  const key = site === "SITE_A" ? "SITE_A" : "SITE_B";
  const client = new pg.Client({
    host: "127.0.0.1",
    port: Number(optional(`${key}_PORT`, site === "SITE_A" ? "5433" : "5434")),
    user: optional(`${key}_USER`, site.toLowerCase()),
    password: required(`${key}_PASSWORD`),
    database: site.toLowerCase(),
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(SCHEMA);
    for (const u of units.filter((u) => u.site_id === site)) {
      await client.query(
        `INSERT INTO platelet_units VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [u.unit_id, u.site_id, u.abo, u.rh, u.irradiated, u.collected_at, u.expires_at, u.status, u.reserved_for, u.updated_at],
      );
    }
    for (const h of usage.filter((h) => h.site_id === site)) {
      await client.query(`INSERT INTO usage_history VALUES ($1,$2,$3,$4,$5)`, [h.site_id, h.day, h.abo, h.rh, h.units_used]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

function toCsv(rows: object[]): string {
  const first = rows[0];
  if (!first) return "";
  const cols = Object.keys(first);
  const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell((r as Record<string, unknown>)[c])).join(","))].join("\n") + "\n";
}

// Site C's "system" is a CSV export inside the Zetaris file root.
function writeSiteC(files: Record<string, string>) {
  const container = optional("ZETARIS_DRIVER_CONTAINER", "zetaris-driver-1");
  const dir = optional("SITE_C_DIR", "/home/zetaris/customer-data/shared/bloodshift/site_c");
  execFileSync("docker", ["exec", "-u", "0", container, "mkdir", "-p", dir]);
  for (const [name, content] of Object.entries(files)) {
    execFileSync("docker", ["exec", "-i", "-u", "0", container, "sh", "-c", `cat > '${dir}/${name}.tmp' && mv '${dir}/${name}.tmp' '${dir}/${name}'`], { input: content });
  }
  execFileSync("docker", ["exec", "-u", "0", container, "chmod", "-R", "a+rwX", dir]);
}

async function seedCourier(slots: unknown[]) {
  const port = optional("COURIER_PORT", "8090");
  const res = await fetch(`http://127.0.0.1:${port}/slots`, { method: "PUT", body: JSON.stringify(slots) });
  if (!res.ok) throw new Error(`Courier seed failed: HTTP ${res.status} ${await res.text()}`);
}

async function main() {
  const seed = Number(optional("SEED", "20261024"));
  const now = new Date();
  const { units, usage } = generate(seed, now);
  await seedPostgres("SITE_A", units, usage);
  await seedPostgres("SITE_B", units, usage);
  writeSiteC({
    "units.csv": toCsv(units.filter((u) => u.site_id === "SITE_C")),
    "usage.csv": toCsv(usage.filter((h) => h.site_id === "SITE_C")),
  });
  const slots = courierSlots(now);
  await seedCourier(slots);
  const count = (s: string) => units.filter((u) => u.site_id === s).length;
  console.log(`Seeded with seed ${seed}: Site A ${count("SITE_A")} units, Site B ${count("SITE_B")}, Site C ${count("SITE_C")}, ${slots.length} courier slots.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
