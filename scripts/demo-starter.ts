// One real starter round on a fresh network, through the app's own API: run the morning plan,
// send it, accept one request, refuse one whose unit was used at its source, and decline one.
// Everything goes through the same checks as a click in the app.
//   npx tsx scripts/demo-starter.ts [http://127.0.0.1:4000]
import { execFileSync } from "node:child_process";

const APP = process.argv[2] ?? "http://127.0.0.1:4000";

interface Transfer {
  id: string;
  unitId: string;
  from: string;
  to: string;
  state: string;
  bookingId?: string;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${APP}${path}`, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bloodshift": "1" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${json.error ?? ""}`);
  return json;
}

const requested = async () =>
  (await call<{ transfers: Transfer[] }>("/api/transfers")).transfers.filter((t) => t.state === "requested");

async function main() {
  await call("/api/plan", {});
  const { sent } = await call<{ sent: number }>("/api/transfers/send", {});
  if (!sent) throw new Error("The plan proposed no transfers, so there's nothing to show. Check the seed and courier slots.");

  // Accept one that isn't from Site A, so Site A keeps a request for the refusal
  let open = await requested();
  const accept = open.find((t) => t.from !== "SITE_A") ?? open[0]!;
  const a = await call<{ transfer: Transfer }>(`/api/transfers/${accept.id}/accept`, { site: accept.to });
  console.log(`Accepted ${accept.unitId} at ${accept.to}: ${a.transfer.state} ${a.transfer.bookingId ?? ""}`);

  // Refusal: the unit is used at Northgate's own database after the plan, then accepted
  open = await requested();
  const stale = open.find((t) => t.from === "SITE_A");
  if (stale) {
    execFileSync("docker", ["exec", "bs_site_a", "psql", "-q", "-U", "site_a", "-d", "site_a", "-c",
      `UPDATE platelet_units SET status='used', updated_at=now() WHERE unit_id='${stale.unitId.replace(/[^A-Z0-9-]/g, "")}'`]);
    const r = await call<{ transfer: Transfer }>(`/api/transfers/${stale.id}/accept`, { site: stale.to });
    console.log(`Accepted ${stale.unitId} after it was used at its source: ${r.transfer.state}`);
  }

  // Decline with a reason, which goes to H-MEM and replans the unit
  open = await requested();
  const decline = open[0];
  if (decline) {
    await call(`/api/transfers/${decline.id}/decline`, { site: decline.to, reason: "Covered by our regular supplier this week." });
    console.log(`Declined ${decline.unitId} at ${decline.to}`);
  }

  const states = (await call<{ transfers: Transfer[] }>("/api/transfers")).transfers.reduce<Record<string, number>>(
    (n, t) => ({ ...n, [t.state]: (n[t.state] ?? 0) + 1 }), {});
  console.log(`Demo ready: ${JSON.stringify(states)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
