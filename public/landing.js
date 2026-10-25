// Landing page. Every number and fragment here comes from the running network's own API.
// When a read fails or there's nothing yet, the tile says so and links to where it gets filled.
const $ = (s) => document.querySelector(s);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c ?? "")));
  return node;
}

const getJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
const utc = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const hoursLeft = (iso) => (Date.parse(iso) - Date.now()) / 3_600_000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function tile(id, title, body, ...fragment) {
  $(id).replaceChildren(el("h3", { class: "l-num" }, title), el("p", {}, body), ...fragment);
}
function unavailable(id, what) {
  tile(id, `${what} isn't reachable right now`, "The live network shows which source is down.", el("a", { href: "/app" }, "Open the live network"));
}

function unitRow(u, siteName) {
  return el("li", { class: "l-row" },
    el("span", { class: "mono" }, u.unitId), el("span", { class: "group" }, `${u.abo}${u.rh}`),
    el("span", {}, `${Math.max(0, Math.round(hoursLeft(u.expiresAt)))}h left`), el("span", { class: "src" }, siteName));
}

function bubble(t, names, note) {
  return el("div", { class: "l-bubble" },
    el("p", { class: "from" }, `${names[t.from] ?? t.from} to ${names[t.to] ?? t.to}`),
    el("p", {}, t.message),
    note ? el("p", { class: "meta" }, note) : "");
}

function renderStock(stock) {
  const names = Object.fromEntries(stock.sites.map((s) => [s.site.id, s.site.name]));
  const live = stock.sites.filter((s) => s.status.ok);
  if (!live.length) {
    unavailable("#tile-live", "Live stock");
    unavailable("#tile-expiring", "Live stock");
    return names;
  }
  const usable = live.flatMap((s) => s.units.filter((u) => u.status === "available" && hoursLeft(u.expiresAt) > 0).map((u) => [u, s.site.name]));
  const read = live.reduce((n, s) => n + s.units.length, 0);
  const systems = live.map((s) => s.site.system).join(", ");
  // One row from each hospital, the soonest to expire
  const rows = live.map((s) => usable.filter(([, n]) => n === s.site.name).sort((a, b) => a[0].expiresAt.localeCompare(b[0].expiresAt))[0]).filter(Boolean);
  tile("#tile-live", `${read} units read live`,
    `From ${systems}${stock.courier.status.ok ? ", plus the courier's slots" : ""}. Read in place through Zetaris, with no copy or sync.`,
    el("ul", { class: "l-rows" }, ...rows.map(([u, n]) => unitRow(u, n))));

  const soon = usable.filter(([u]) => hoursLeft(u.expiresAt) <= 24).sort((a, b) => a[0].expiresAt.localeCompare(b[0].expiresAt));
  tile("#tile-expiring", soon.length ? `${plural(soon.length, "unit")} expire within 24h` : "No units expire within 24h",
    "Available units across the network, by hours left. The morning plan projects which of them would go unused.",
    soon.length ? el("ul", { class: "l-rows" }, ...soon.slice(0, 3).map(([u, n]) => unitRow(u, n))) : "");
  return names;
}

function refusalReason(t, names) {
  const c = t.check ?? {};
  if (c.unitStatus && c.unitStatus !== "available") return `${names[t.from] ?? t.from}'s record showed ${t.unitId} as ${c.unitStatus} when the lab accepted at ${utc(c.queriedAt)}. Nothing was written.`;
  if (c.slotStatus && c.slotStatus !== "open") return `Courier slot ${t.slotId} was ${c.slotStatus} by the time the lab accepted. Nothing was written.`;
  return t.reason ?? "The source changed after the plan. Nothing was written.";
}

function renderTransfers(transfers, names) {
  const newest = (states) => transfers.filter((t) => states.includes(t.state)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const reserved = newest(["reserved", "dispatched", "received"]);
  if (reserved.length) {
    const r = reserved[0];
    tile("#tile-reserved", `${plural(reserved.length, "transfer")} reserved`, "Each one reserved in the sender's own system, with the courier booked.",
      bubble(r, names, `Reserved ${utc(r.updatedAt)} · Booking ${r.bookingId}`));
  } else {
    tile("#tile-reserved", "No transfers yet", "Run the morning plan, send the requests, and accept one as a lab. It shows up here.",
      el("a", { href: "/app" }, "Run the morning plan"));
  }

  const refused = newest(["refused"]);
  if (refused.length) {
    const r = refused[0];
    tile("#tile-refused", "Refused when the source changed", refusalReason(r, names),
      r.replacementNote ? el("p", { class: "l-small" }, r.replacementNote) : "");
  } else {
    tile("#tile-refused", "None refused yet", "If a unit is used or moved at its hospital after the plan, accepting it is refused and nothing is written.");
  }

  // Hero: the newest request waiting on a lab, else the newest transfer of any kind
  const hero = newest(["requested"])[0] ?? reserved[0];
  const slot = $("#hero-bubble");
  if (hero) {
    slot.replaceChildren(el("p", { class: "from" }, `${names[hero.from] ?? hero.from} to ${names[hero.to] ?? hero.to}`),
      el("p", {}, `Can send ${hero.abo}${hero.rh} ${hero.unitId}, arriving ${utc(hero.arrivesAt)}.`),
      el("a", { href: `/app?view=${encodeURIComponent(hero.to)}` }, hero.state === "requested" ? `Open ${names[hero.to] ?? hero.to}'s inbox` : "See it in the live network"));
    slot.classList.add("on");
  }
  return reserved[0];
}

function renderDeclines(declines, transfers, names) {
  const d = declines[0];
  if (!d) {
    tile("#tile-declined", "Labs can say no", "No declines yet. When a lab declines with a reason, it's kept in Meterless H-MEM and the unit goes elsewhere.");
    return;
  }
  const t = transfers.find((x) => x.id === d.transferId);
  tile("#tile-declined", "Labs can say no", `${names[d.site] ?? d.site} declined ${d.unitId} (${d.group}) on ${utc(d.at)}:`,
    el("blockquote", { class: "l-quote" }, d.reason),
    t?.replacementNote ? el("p", { class: "l-small" }, t.replacementNote) : "");
}

function renderSim(sim) {
  const pct = Math.round(sim.outdateReduction * 100);
  const [lo, hi] = sim.outdateReductionRange.map((x) => Math.round(x * 100));
  const groups = Object.keys(sim.outdatesByGroup.noSharing).sort();
  const max = Math.max(...groups.flatMap((g) => [sim.outdatesByGroup.noSharing[g], sim.outdatesByGroup.rule[g] ?? 0]));
  const bars = el("div", { class: "l-bars", role: "img", "aria-label": `Outdated units by blood group over ${sim.days} days, without and with sharing` },
    ...groups.map((g) => el("div", { class: "l-bar" },
      el("span", { class: "b none", style: `height:${(sim.outdatesByGroup.noSharing[g] / max) * 100}%` }),
      el("span", { class: "b rule", style: `height:${((sim.outdatesByGroup.rule[g] ?? 0) / max) * 100}%` }),
      el("span", { class: "g" }, g))));
  tile("#tile-sim", `${pct}% fewer outdates`,
    `Average over ${sim.runs} simulated runs of ${sim.days} days, ${lo}% to ${hi}% across runs. Synthetic demand, not a measured result.`,
    bars, el("p", { class: "l-legend" }, el("span", { class: "k none" }), "No sharing ", el("span", { class: "k rule" }), "With Bloodshift"),
    el("a", { href: "/simulation" }, "See the simulation"));
}

const STEPS = [
  ["Read live", "Zetaris reads each hospital's own system in place: two Postgres databases, a CSV export and the courier's API.",
    (t) => t && [`Read at ${utc(t.evidence.queriedAt)}`, t.evidence.sql]],
  ["Plan", "A fixed rule projects which units would expire unused and lists every transfer that passes the rules. Nemotron picks among those and writes the request.",
    (t) => t && [`Written by ${t.messageBy === "nemotron" ? "Nemotron" : "the standard template"}`, t.message]],
  ["Request", "The receiving lab gets the request in its inbox and can accept or decline with a reason.",
    (t) => t && [`Sent to the receiving lab`, t.message]],
  ["Re-check", "On accept, Bloodshift reads the unit and the courier slot again. If either changed, it refuses and writes nothing.",
    (t) => t?.check && [`Re-checked at ${utc(t.check.queriedAt)}`, t.check.sql.join("\n")]],
  ["Reserve and book", "The unit is reserved in the sender's own system and the courier is booked. A final read confirms both.",
    (t) => t?.confirmation && [`Confirmed at ${utc(t.confirmation.queriedAt)} · Booking ${t.bookingId}`, `unit ${t.confirmation.unitStatus} for ${t.confirmation.reservedFor}, slot ${t.confirmation.slotStatus}`]],
];

function renderSteps(example) {
  const list = $(".l-steps");
  const panel = $("#step-panel");
  const show = (i) => {
    [...list.children].forEach((b, j) => b.setAttribute("aria-selected", String(i === j)));
    const [, text, proof] = STEPS[i];
    const p = proof(example);
    panel.replaceChildren(el("p", {}, text),
      p ? el("div", { class: "l-proof" }, el("p", { class: "meta" }, `${p[0]} · ${example.unitId}`), el("pre", {}, p[1]))
        : el("p", { class: "meta" }, "Run the morning plan and accept a transfer to see a real example here. ", el("a", { href: "/app" }, "Open the live network")));
  };
  list.replaceChildren(...STEPS.map(([name], i) => {
    const b = el("button", { type: "button", role: "tab", class: "l-step" }, `${i + 1} ${name}`);
    b.addEventListener("click", () => show(i));
    return b;
  }));
  show(0);
}

(async () => {
  const [stock, tr, dec, sim] = await Promise.allSettled([getJson("/api/stock"), getJson("/api/transfers"), getJson("/api/declines"), getJson("/api/simulation")]);
  let names = {};
  if (stock.status === "fulfilled") names = renderStock(stock.value);
  else { unavailable("#tile-live", "Live stock"); unavailable("#tile-expiring", "Live stock"); }

  const transfers = tr.status === "fulfilled" ? tr.value.transfers : [];
  let example;
  if (tr.status === "fulfilled") example = renderTransfers(transfers, names);
  else { unavailable("#tile-reserved", "The transfer log"); unavailable("#tile-refused", "The transfer log"); }

  if (dec.status === "fulfilled") renderDeclines(dec.value.declines, transfers, names);
  else unavailable("#tile-declined", "Decline memory");

  if (sim.status === "fulfilled") renderSim(sim.value);
  else tile("#tile-sim", "Simulation unavailable", "The simulation page shows the full results.", el("a", { href: "/simulation" }, "See the simulation"));

  renderSteps(example);
})();
