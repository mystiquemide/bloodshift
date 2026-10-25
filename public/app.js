const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c ?? "")));
  return node;
}

function hoursLeft(iso) {
  return Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000);
}

function time(iso) {
  return new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

const SITE_TINT = { SITE_A: "tint-blue", SITE_B: "tint-green", SITE_C: "tint-pink" };
const STATUS_LABEL = { available: "Available", reserved: "Reserved", used: "Used", expired: "Expired", open: "Open", booked: "Booked" };

function siteCard(s) {
  // A unit past its expiry can still say "available" at the source. It isn't usable, so it isn't counted.
  const usable = s.units.filter((u) => u.status === "available" && hoursLeft(u.expiresAt) > 0);
  const soon = usable.filter((u) => hoursLeft(u.expiresAt) <= 24);
  const lapsed = s.units.filter((u) => u.status === "available" && hoursLeft(u.expiresAt) <= 0).length;
  const card = el("article", { class: `site ${s.status.ok ? SITE_TINT[s.site.id] ?? "" : "down"}` },
    el("h2", {}, s.site.name),
    el("p", { class: "source" }, s.site.system),
    el("a", { class: "inbox-link", href: `/app?view=${encodeURIComponent(s.site.id)}` }, `Open ${s.site.name}'s inbox`));

  if (!s.status.ok) {
    card.append(el("p", { class: "error" }, "Can't read this hospital right now. ", s.status.error));
    return card;
  }
  card.append(
    el("p", { class: "source" }, `Read through Zetaris at ${time(s.status.queriedAt)}`),
    el("div", { class: "stats" },
      el("div", {}, el("strong", {}, usable.length), el("span", {}, "available")),
      el("div", { class: soon.length ? "warn" : "" }, el("strong", {}, soon.length), el("span", {}, "expire within 24h")),
      lapsed ? el("div", { class: "lapsed" }, el("strong", {}, lapsed), el("span", {}, "past expiry, still listed")) : ""),
  );
  if (s.units.length === 0) {
    card.append(el("p", { class: "empty" }, "No platelet units at this hospital."));
    return card;
  }
  const rows = s.units.map((u) => {
    const h = hoursLeft(u.expiresAt);
    const lapsedRow = u.status === "available" && h <= 0;
    return el("tr", { title: u.source },
      el("td", { class: "mono" }, u.unitId),
      el("td", {}, el("span", { class: "group" }, `${u.abo}${u.rh}`), u.irradiated ? el("span", { class: "irr", title: "Irradiated" }, " irr") : ""),
      el("td", { class: lapsedRow ? "lapsed" : u.status === "available" && h <= 24 ? "warn" : "" }, h <= 0 ? "expired" : `${h}h`),
      el("td", {}, el("span", { class: `badge ${lapsedRow ? "expired" : u.status}` }, lapsedRow ? "Past expiry" : STATUS_LABEL[u.status] ?? u.status), u.reservedFor ? el("span", { class: "for" }, `for ${siteName(u.reservedFor)}`) : ""));
  });
  card.append(el("div", { class: "table-wrap inner" }, el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, "Unit"), el("th", {}, "Group"), el("th", {}, "Expires in"), el("th", {}, "Status"))),
    el("tbody", {}, ...rows))));
  return card;
}

function render(data) {
  const down = data.sites.filter((s) => !s.status.ok).map((s) => s.site.name);
  if (!data.courier.status.ok) down.push("the courier");
  const live = data.sites.filter((s) => s.status.ok).length + (data.courier.status.ok ? 1 : 0);
  const status = $("#status");
  status.className = "status " + data.state;
  status.textContent =
    data.state === "loaded" ? `All ${live} sources live: 3 hospital systems and the courier, read through Zetaris.` :
    data.state === "partial" ? `Can't read ${down.join(", ")} right now. The other sources are live.` :
    "No source could be read. Zetaris or the hospital systems aren't answering.";

  $("#sites").replaceChildren(...data.sites.map(siteCard));

  const cs = data.courier.status;
  $("#courier-status").textContent = cs.ok ? `Read through Zetaris at ${time(cs.queriedAt)}` : `Can't read the courier right now. ${cs.error}`;
  $("#slots tbody").replaceChildren(...data.courier.slots.map((s) => el("tr", {},
    el("td", { class: "mono" }, s.slotId), el("td", {}, `${siteName(s.fromSite)} to ${siteName(s.toSite)}`), el("td", {}, time(s.departsAt)),
    el("td", {}, el("span", { class: `badge ${s.status}` }, STATUS_LABEL[s.status] ?? s.status)), el("td", { class: "mono" }, s.bookingId ?? ""))));
}

async function load() {
  const btn = $("#refresh");
  btn.disabled = true;
  $("#status").className = "status loading";
  $("#status").textContent = "Reading live stock through Zetaris";
  try {
    const res = await fetch("/api/stock");
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    render(await res.json());
  } catch (err) {
    $("#status").className = "status error";
    $("#status").textContent = `Couldn't load stock: ${problem(err)}`;
  } finally {
    btn.disabled = false;
  }
}

const SITE_NAMES = { SITE_A: "Northgate General", SITE_B: "Riverside Medical", SITE_C: "Hillcrest Community" };
const siteName = (id) => SITE_NAMES[id] ?? id;

async function post(path) {
  const res = await fetch(path, { method: "POST", headers: { "X-Bloodshift": "1" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

function planStatus(kind, text) {
  const p = $("#plan-status");
  p.hidden = !text;
  p.className = "status " + kind;
  p.textContent = text ?? "";
}

function snapshotLine(label, c) {
  if (!c) return "";
  const unit = c.unitStatus ? `unit ${c.unitStatus}${c.reservedFor ? ` for ${c.reservedFor}` : ""}` : "unit not found";
  const slot = c.slotStatus ? `slot ${c.slotStatus}${c.bookingId ? ` (${c.bookingId})` : ""}` : "slot not found";
  return el("p", { class: "source" }, `${label} via Zetaris at ${time(c.queriedAt)}: ${unit}, ${slot}.`);
}

const STATE_LABEL = {
  proposed: "Proposed", requested: "Requested", checking: "Checking source", reserved: "Reserved",
  refused: "Refused", declined: "Declined", failed: "Failed", superseded: "Replaced", dispatched: "Dispatched", received: "Received", cancelled: "Cancelled",
};

function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : time(iso);
}

// A transfer reads as a message from the sending hospital to the receiving lab
function transferCard(t, actions = []) {
  const e = t.evidence;
  const stateText = t.state === "checking" ? `checking ${siteName(t.from)}` : STATE_LABEL[t.state] ?? t.state;
  return el("article", { class: `transfer state-${t.state}`, "data-id": t.id },
    el("div", { class: "transfer-head" },
      el("span", { class: "from" }, `${siteName(t.from)} to ${siteName(t.to)}`),
      el("span", { class: `badge ${t.state}` }, stateText)),
    el("div", { class: "bubble" },
      el("p", { class: "message" }, t.message),
      el("p", { class: "by" }, t.messageBy === "nemotron" ? `Written by Nemotron · ${ago(t.updatedAt)}` : `Standard template · ${ago(t.updatedAt)}`)),
    el("div", { class: "facts" },
      el("strong", { class: "mono" }, t.unitId),
      el("span", { class: "group" }, `${t.abo}${t.rh}`),
      t.irradiated ? el("span", { class: "chip" }, "Irradiated") : "",
      el("span", { class: "chip" }, `Slot ${t.slotId}`),
      el("span", { class: "chip" }, `Arrives ${time(t.arrivesAt)}`)),
    t.state === "reserved" ? el("p", { class: "ok" }, `Reserved at ${siteName(t.from)}. Courier booking ${t.bookingId}.`) : "",
    t.reason ? el("p", { class: "reason" }, t.state === "refused" ? `Refused: ${t.reason}` : t.state === "declined" ? `Declined: ${t.reason}` : t.reason) : "",
    t.replacementNote ? el("p", { class: "replacement" }, t.replacementNote) : "",
    t.replaces ? el("p", { class: "source" }, `Replaces ${t.replaces.split("-").slice(-3).join("-")}, which was declined or refused.`) : "",
    el("p", { class: "source" }, `Planned from ${e.source}. It was ${e.status} and expires ${time(e.expiresAt)}.`),
    t.state === "reserved" ? snapshotLine("Confirmed", t.confirmation) : snapshotLine("Checked", t.check),
    actions.length ? el("div", { class: "actions" }, ...actions) : "",
    sourceControl(t),
    proofDrawer(t));
}

// Set from /api/transfers. Off on any deployment that isn't a demo.
let demoControls = false;

// Lets anyone watch the invariant hold: change the unit in the sending hospital's own system,
// the way its lab would when it issues the unit locally, then accept and see the refusal.
function sourceControl(t) {
  if (!demoControls || t.state !== "requested") return "";
  const from = siteName(t.from);
  const box = el("div", { class: "source-sim" });
  const b = el("button", { type: "button", class: "secondary" }, `Mark ${t.unitId} used at ${from}`);
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      const read = await postJson(`/api/transfers/${encodeURIComponent(t.id)}/source/used`, {});
      box.replaceChildren(el("p", { class: "warn", role: "status" },
        `${from}'s own record now says ${t.unitId} is ${read.row?.status ?? "changed"}. Accept it to watch Bloodshift refuse it.`));
    } catch (err) {
      box.replaceChildren(el("p", { class: "reason", role: "status" }, `Couldn't change it: ${problem(err)}`));
    }
  });
  box.append(
    el("p", { class: "label" }, "Try the refusal"),
    b,
    el("p", { class: "source" }, `Changes ${from}'s own record, the way its lab system would when it issues the unit. Bloodshift isn't told.`));
  return box;
}

function directBlock(d) {
  const r = d.row;
  const text = r
    ? `${d.unitId} is ${r.status}${r.reservedFor ? ` for ${r.reservedFor}` : ""}, last updated ${r.updatedAt}.`
    : `${d.unitId} isn't in its system.`;
  return el("div", { class: "proof-step direct" },
    el("p", {}, el("strong", {}, "Hospital's own record"), ` read directly from ${siteName(d.site)} (${d.system}), not through Zetaris, at ${d.readAt.replace("T", " ").slice(0, 19)} UTC`),
    el("p", { class: "source" }, text));
}

function sqlBlock(label, sql, when, detail) {
  if (!sql || !sql.length) return "";
  return el("div", { class: "proof-step" },
    el("p", {}, el("strong", {}, label), ` via Zetaris at ${new Date(when).toISOString().replace("T", " ").slice(0, 19)} UTC`),
    ...[].concat(sql).map((q) => el("pre", {}, q)),
    detail ? el("p", { class: "source" }, detail) : "");
}

function snapshotDetail(c) {
  return `Returned: unit ${c.unitStatus ?? "not found"}${c.reservedFor ? ` for ${c.reservedFor}` : ""}, expires ${c.expiresAt ?? "?"}, slot ${c.slotStatus ?? "not found"}${c.bookingId ? ` (${c.bookingId})` : ""}.`;
}

// Everything a judge needs to see that the decision came from live rows, loaded on demand
function proofDrawer(t) {
  const body = el("div", { class: "proof-body" });
  const box = el("details", { class: "proof" }, el("summary", {}, "Proof"), body);
  box.addEventListener("toggle", async () => {
    if (!box.open || body.childElementCount) return;
    body.append(el("p", { class: "source" }, "Loading the proof"));
    try {
      const id = encodeURIComponent(t.id);
      const [{ transfer: x, history }, direct] = await Promise.all([
        fetch(`/api/transfers/${id}/history`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
        fetch(`/api/transfers/${id}/source`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      body.replaceChildren(
        direct ? directBlock(direct) : el("p", { class: "source" }, "The hospital's own record couldn't be read directly right now."),
        sqlBlock("Planned from", x.evidence.sql, x.evidence.queriedAt, `Returned: ${x.evidence.status}, expires ${x.evidence.expiresAt}. Source: ${x.evidence.source}.`),
        x.check ? sqlBlock("Re-checked at accept", x.check.sql, x.check.queriedAt, snapshotDetail(x.check)) : "",
        x.confirmation ? sqlBlock("Confirmed after the writes", x.confirmation.sql, x.confirmation.queriedAt, snapshotDetail(x.confirmation)) : "",
        x.bookingId ? el("p", {}, el("strong", {}, "Courier booking "), x.bookingId) : "",
        el("p", {}, el("strong", {}, "History")),
        el("ol", { class: "history" }, ...history.map((h) => el("li", {}, `${h.state} by ${h.by}, ${new Date(h.at).toISOString().replace("T", " ").slice(0, 19)} UTC${h.reason ? `: ${h.reason}` : ""}`))),
        el("p", { class: "source" }, `Transfer ${x.id}, recorded in the Meterless World Model event log.`));
    } catch (err) {
      body.replaceChildren(el("p", { class: "reason" }, `Couldn't load the proof: ${problem(err)}`));
    }
  });
  return box;
}

function renderTransfers(transfers) {
  const shown = transfers.filter((t) => t.state !== "superseded");
  $("#transfers").replaceChildren(...(shown.length ? shown.map(transferCard) : [el("p", { class: "empty" }, "No transfers yet. Run the morning plan.")]));
  const proposed = transfers.filter((t) => t.state === "proposed").length;
  $("#send").hidden = proposed === 0;
  $("#send").textContent = `Send ${proposed} ${proposed === 1 ? "request" : "requests"}`;
}

function renderSummary(run) {
  const box = $("#plan-summary");
  box.hidden = false;
  const reduction = run.outdatesBefore ? Math.round((1 - run.outdatesAfter / run.outdatesBefore) * 100) : 0;
  box.replaceChildren(
    el("div", { class: "stat" }, el("strong", {}, run.outdatesBefore), el("span", {}, "projected outdates without the plan")),
    el("div", { class: "stat good" }, el("strong", {}, run.outdatesAfter), el("span", {}, run.outdatesBefore ? `with the plan, ${reduction}% fewer` : "with the plan")),
    el("div", { class: "stat" }, el("strong", {}, run.transfers.length), el("span", {}, run.transfers.length === 1 ? "transfer proposed" : "transfers proposed")),
    el("p", { class: "source" }, "Projected from live stock and 30 days of use at each hospital. Not a measured result."));
}

async function loadTransfers() {
  try {
    const res = await fetch("/api/transfers");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    demoControls = !!data.demoControls;
    renderTransfers(data.transfers);
  } catch (err) {
    planStatus("error", `Couldn't load transfers: ${problem(err)}`);
  }
}

$("#run-plan").addEventListener("click", async () => {
  const btn = $("#run-plan");
  btn.disabled = true;
  btn.textContent = "Planning";
  planStatus("loading", "Reading live stock through Zetaris, then asking Nemotron to write the requests. This can take up to 20 seconds.");
  try {
    const run = await post("/api/plan");
    renderSummary(run);
    planStatus(run.modelNotice ? "partial" : "loaded",
      run.modelNotice ? `Planned without model. ${run.modelNotice}` :
      run.transfers.length ? "Planned." : "Planned. No transfer would prevent an outdate right now.");
    await loadTransfers();
    load();
  } catch (err) {
    planStatus("error", problem(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Run morning plan";
  }
});

$("#send").addEventListener("click", async () => {
  const btn = $("#send");
  btn.disabled = true;
  try {
    const { sent } = await post("/api/transfers/send");
    planStatus("loaded", `Sent ${sent.length} request${sent.length === 1 ? "" : "s"} to the receiving sites.`);
    await loadTransfers();
  } catch (err) {
    planStatus("error", `Couldn't send: ${problem(err)}`);
  } finally {
    btn.disabled = false;
  }
});

// A ?view= link opens that lab's inbox directly. Without one, use the last view picked here.
const VIEWS = [...$("#view").options].map((o) => o.value);
let view = new URLSearchParams(location.search).get("view")?.toUpperCase() ?? "";
if (!VIEWS.includes(view)) {
  try { view = localStorage.getItem("bloodshift-view") || ""; } catch {}
}
if (!VIEWS.includes(view)) view = "COORDINATOR";

async function act(t, kind, btn) {
  btn.disabled = true;
  const card = btn.closest(".transfer");
  card.querySelector(".badge").className = "badge checking";
  card.querySelector(".badge").textContent = `checking ${siteName(t.from)}`;
  card.className = "transfer state-checking";
  const row = btn.closest(".actions");
  row.replaceChildren(el("p", { class: "progress", role: "status" }, `Checking ${siteName(t.from)}'s record through Zetaris, then booking the courier.`));
  try {
    const out = await postJson(`/api/transfers/${encodeURIComponent(t.id)}/${kind}`, { site: view });
    if (out.transfer.state === "refused") inboxStatus("partial", `Refused: ${out.transfer.reason}. ${out.replan?.note ?? ""}`);
    else if (out.transfer.state === "reserved") inboxStatus("loaded", `Reserved at ${siteName(t.from)}. Courier booking ${out.transfer.bookingId}.`);
    else if (out.transfer.state === "failed") inboxStatus("error", out.transfer.reason);
  } catch (err) {
    inboxStatus("error", problem(err));
  }
  // Both panels re-read through Zetaris, so the stock table shows the reservation too
  await Promise.all([loadInbox(), load()]);
}

function openDecline(t, btn) {
  const card = btn.closest(".transfer");
  if (card.querySelector(".decline-form")) return;
  const input = el("textarea", { maxlength: "500", rows: "2", "aria-label": `Reason for declining ${t.unitId}`, placeholder: "Why can't your site use this unit?" });
  const send = el("button", { type: "submit" }, "Decline with reason");
  const cancel = el("button", { type: "button", class: "secondary" }, "Cancel");
  const form = el("form", { class: "decline-form" }, input, el("div", { class: "actions" }, send, cancel));
  cancel.addEventListener("click", () => form.remove());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const reason = input.value.trim();
    if (!reason) { input.focus(); return; }
    send.disabled = true;
    send.textContent = "Declining and replanning";
    try {
      const out = await postJson(`/api/transfers/${encodeURIComponent(t.id)}/decline`, { site: view, reason });
      inboxStatus(out.replacement ? "loaded" : "partial", `Declined. ${out.note}`);
    } catch (err) {
      inboxStatus("error", `Couldn't decline: ${problem(err)}`);
    }
    await Promise.all([loadInbox(), loadNotes()]);
  });
  card.append(form);
  input.focus();
}

// Turns a failed request into something a lab user can act on. The server's own messages
// are already written for people and pass through as they are.
function problem(err) {
  if (err instanceof TypeError) return "Bloodshift isn't reachable. Check your connection, then try again.";
  if (/^HTTP 5\d\d/.test(err.message)) return "Something went wrong on the server. Try again in a moment.";
  if (/^HTTP \d+/.test(err.message) || err instanceof SyntaxError) return "The server sent something unexpected. Refresh the page and try again.";
  return err.message;
}

async function postJson(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "X-Bloodshift": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
  return out;
}

function inboxStatus(kind, text) {
  const p = $("#inbox-status");
  p.hidden = !text;
  p.className = "status " + kind;
  p.textContent = text ?? "";
}

const INBOX_GROUPS = [
  { title: "Waiting for you", states: ["requested", "checking"] },
  { title: "Needs a retry", states: ["failed"] },
  { title: "Reserved", states: ["reserved", "dispatched", "received"] },
  { title: "Refused", states: ["refused"] },
  { title: "Declined", states: ["declined"] },
];

function inboxActions(t) {
  const actions = [];
  if (t.state === "requested") {
    const b = el("button", { type: "button" }, "Accept");
    b.addEventListener("click", () => act(t, "accept", b));
    const d = el("button", { type: "button", class: "secondary" }, "Decline");
    d.addEventListener("click", () => openDecline(t, d));
    actions.push(b, d);
  }
  if (t.state === "failed") {
    const b = el("button", { type: "button" }, "Retry");
    b.addEventListener("click", () => act(t, "retry", b));
    actions.push(b);
  }
  return actions;
}

async function loadInbox() {
  try {
    const res = await fetch("/api/transfers");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    demoControls = !!data.demoControls;
    const mine = data.transfers.filter((t) => t.to === view && !["proposed", "superseded"].includes(t.state));
    const waiting = mine.filter((t) => t.state === "requested").length;
    $("#inbox-h").textContent = `Requests for ${siteName(view)}`;
    $("#inbox-count").textContent = waiting ? `${waiting} waiting` : "Nothing waiting";
    $("#inbox-count").className = "count" + (waiting ? " has" : "");
    if (!mine.length) {
      $("#inbox-list").replaceChildren(el("div", { class: "transfer state-empty" },
        el("div", { class: "transfer-head" }, el("span", { class: "from" }, "Bloodshift")),
        el("div", { class: "bubble" }, el("p", { class: "message" },
          `No requests for ${siteName(view)} right now. When another hospital can send you a unit that would otherwise expire, the request lands here.`))));
      return;
    }
    const sections = INBOX_GROUPS.map((g) => {
      const items = mine.filter((t) => g.states.includes(t.state)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (!items.length) return null;
      return el("section", { class: "inbox-group", "aria-label": g.title },
        el("h3", {}, g.title, " ", el("span", { class: "n" }, items.length)),
        el("div", { class: "transfers" }, ...items.map((t) => transferCard(t, inboxActions(t)))));
    }).filter(Boolean);
    $("#inbox-list").replaceChildren(...sections);
  } catch (err) {
    inboxStatus("error", `Couldn't load the inbox: ${problem(err)}`);
  }
}

async function loadNotes() {
  const list = $("#notes");
  try {
    const res = await fetch(`/api/declines?site=${encodeURIComponent(view)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { declines } = await res.json();
    list.replaceChildren(...(declines.length
      ? declines.map((n) => el("li", {},
          el("p", {}, el("strong", {}, `${new Date(n.at).toISOString().replace("T", " ").slice(0, 16)} UTC`), ` · ${n.unitId} (${n.group}) · "${n.reason}"`),
          el("p", { class: "source" }, `Memory ${n.memoryId}, from transfer ${n.transferId}, declined by ${n.by}.`)))
      : [el("li", { class: "empty" }, "No declines yet. Reasons you give appear here and in later plans.")]));
  } catch (err) {
    list.replaceChildren(el("li", { class: "reason" }, `Couldn't load decline notes: ${problem(err)}`));
  }
}

function applyView() {
  $("#view").value = view;
  const url = new URL(location.href);
  if (view === "COORDINATOR") url.searchParams.delete("view"); else url.searchParams.set("view", view);
  history.replaceState(null, "", url);
  const coordinator = view === "COORDINATOR";
  $("#coordinator").hidden = !coordinator;
  $("#inbox").hidden = coordinator;
  if (!coordinator) {
    $("#inbox-h").textContent = `Requests for ${siteName(view)}`;
    inboxStatus("", "");
    loadInbox();
    loadNotes();
  } else {
    loadTransfers();
  }
}

$("#view").addEventListener("change", (e) => {
  view = e.target.value;
  try { localStorage.setItem("bloodshift-view", view); } catch {}
  applyView();
});

$("#refresh").addEventListener("click", () => { load(); applyView(); });
load();
applyView();
