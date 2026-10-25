// Reads live platelet stock for every site through Zetaris.
// Each source is queried on its own so one unreachable site doesn't hide the others.
import { SITES, COURIER_SOURCE, type Site, type SiteId } from "./sites.js";
import { ZetarisError, type QueryResult } from "./zetaris.js";

export interface Querier {
  query(sql: string): Promise<QueryResult>;
}

export interface StockUnit {
  unitId: string;
  siteId: SiteId;
  abo: string;
  rh: string;
  irradiated: boolean;
  expiresAt: string;
  status: string;
  reservedFor: string | null;
  // Where this row came from, shown on every row in the UI
  source: string;
}

export interface CourierSlot {
  slotId: string;
  fromSite: string;
  toSite: string;
  departsAt: string;
  arrivesAt: string;
  status: string;
  bookingId: string | null;
}

export type SourceStatus =
  | { ok: true; queriedAt: string; engineMs: number | null }
  | { ok: false; error: string };

export interface SiteStock {
  site: Site;
  status: SourceStatus;
  units: StockUnit[];
}

export interface NetworkStock {
  state: "loaded" | "partial" | "error";
  sites: SiteStock[];
  courier: { status: SourceStatus; slots: CourierSlot[] };
}

const UNIT_COLUMNS = "unit_id, site_id, abo, rh, irradiated, expires_at, status, reserved_for";

export function unitsSql(site: Site): string {
  return `SELECT ${UNIT_COLUMNS} FROM ${site.zetarisSource}.platelet_units ORDER BY expires_at`;
}

export const COURIER_SQL = `SELECT slot_id, from_site, to_site, departs_at, arrives_at, status, booking_id FROM ${COURIER_SOURCE}.slots`;

// Every route a unit could take right now, in one federated statement: available units from
// Site A and Site B (Postgres) and Site C (CSV), joined with open slots from the courier (REST).
export const ROUTES_SQL =
  `SELECT u.unit_id, s.slot_id FROM (${SITES.map((s) => `SELECT unit_id, site_id, status FROM ${s.zetarisSource}.platelet_units`).join(" UNION ALL ")}) u ` +
  `JOIN ${COURIER_SOURCE}.slots s ON s.from_site = u.site_id WHERE u.status = 'available' AND s.status = 'open'`;

export interface Routes {
  sql: string;
  queriedAt: string;
  // "unitId|slotId" for every pair the federated read returned
  pairs: Set<string>;
}

export const routeKey = (unitId: string, slotId: string) => `${unitId}|${slotId}`;

export async function readRoutes(zetaris: Querier): Promise<Routes> {
  const result = await zetaris.query(ROUTES_SQL);
  return { sql: ROUTES_SQL, queriedAt: result.queriedAt, pairs: new Set(result.rows.map((r) => routeKey(str(r.unit_id), str(r.slot_id)))) };
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function nullable(v: unknown): string | null {
  const s = str(v).trim();
  return s === "" || s === "null" ? null : s;
}

// CSV and Postgres sources disagree on booleans and timestamps. Normalise once here.
function bool(v: unknown): boolean {
  return v === true || /^(true|t|1)$/i.test(str(v));
}

// Zetaris returns Spark timestamps without a zone, in the engine's UTC session time.
// Without the explicit Z they'd be read in the app server's local zone.
export function isoTime(v: unknown): string {
  let s = str(v).trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += "Z";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Unreadable timestamp from source: ${str(v)}`);
  return d.toISOString();
}

export function toUnit(row: Record<string, unknown>, site: Site): StockUnit {
  const unitId = str(row.unit_id);
  if (!unitId) throw new Error(`Row without unit_id from ${site.system}`);
  return {
    unitId,
    siteId: site.id,
    abo: str(row.abo),
    rh: str(row.rh),
    irradiated: bool(row.irradiated),
    expiresAt: isoTime(row.expires_at),
    status: str(row.status),
    reservedFor: nullable(row.reserved_for),
    source: `${site.system} via Zetaris ${site.zetarisSource}.platelet_units`,
  };
}

export function toSlot(row: Record<string, unknown>): CourierSlot {
  return {
    slotId: str(row.slot_id),
    fromSite: str(row.from_site),
    toSite: str(row.to_site),
    departsAt: isoTime(row.departs_at),
    arrivesAt: isoTime(row.arrives_at),
    status: str(row.status),
    bookingId: nullable(row.booking_id),
  };
}

// Engine errors carry Java stack text. Log it for the operator, show the actor a plain reason.
function failure(err: unknown, what: string): SourceStatus {
  console.error(`Read failed for ${what}:`, err instanceof Error ? err.message : err);
  if (err instanceof ZetarisError) {
    if (err.kind === "unreachable") return { ok: false, error: "Zetaris isn't reachable." };
    if (err.kind === "auth") return { ok: false, error: "Zetaris rejected the app's sign-in." };
    return { ok: false, error: `Zetaris couldn't read ${what}. The source may be offline.` };
  }
  return { ok: false, error: `${what} returned data the app couldn't read.` };
}

export async function readNetworkStock(zetaris: Querier): Promise<NetworkStock> {
  const siteReads = SITES.map(async (site): Promise<SiteStock> => {
    try {
      const result = await zetaris.query(unitsSql(site));
      return {
        site,
        status: { ok: true, queriedAt: result.queriedAt, engineMs: result.engineMs },
        units: result.rows.map((r) => toUnit(r, site)),
      };
    } catch (err) {
      return { site, status: failure(err, site.system), units: [] };
    }
  });

  const courierRead = (async () => {
    try {
      const result = await zetaris.query(COURIER_SQL);
      return {
        status: { ok: true, queriedAt: result.queriedAt, engineMs: result.engineMs } as SourceStatus,
        slots: result.rows.map(toSlot),
      };
    } catch (err) {
      return { status: failure(err, "the courier service"), slots: [] as CourierSlot[] };
    }
  })();

  const [sites, courier] = await Promise.all([Promise.all(siteReads), courierRead]);
  const okCount = sites.filter((s) => s.status.ok).length + (courier.status.ok ? 1 : 0);
  const state = okCount === sites.length + 1 ? "loaded" : okCount === 0 ? "error" : "partial";
  return { state, sites, courier };
}

export interface UsageRow {
  site_id: string;
  abo: string;
  rh: string;
  days: number;
  used: number;
}

// Usage history per group, aggregated at each source. Feeds the expiry projection.
export async function readUsage(zetaris: Querier): Promise<UsageRow[]> {
  const results = await Promise.all(
    SITES.map((site) =>
      zetaris.query(
        `SELECT site_id, abo, rh, COUNT(DISTINCT day) AS days, SUM(units_used) AS used FROM ${site.zetarisSource}.usage_history GROUP BY site_id, abo, rh`,
      ),
    ),
  );
  return results.flatMap((r) =>
    r.rows.map((row) => ({ site_id: str(row.site_id), abo: str(row.abo), rh: str(row.rh), days: Number(row.days), used: Number(row.used) })),
  );
}
