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

function siteCard(s) {
  const available = s.units.filter((u) => u.status === "available");
  const soon = available.filter((u) => hoursLeft(u.expiresAt) <= 24);
  const card = el("article", { class: "site" + (s.status.ok ? "" : " down") },
    el("h2", {}, s.site.name, " ", el("span", { class: "tag" }, s.site.id)),
    el("p", { class: "source" }, `Source: ${s.site.system}`));

  if (!s.status.ok) {
    card.append(el("p", { class: "error" }, "Unavailable. ", s.status.error));
    return card;
  }
  card.append(
    el("p", { class: "source" }, `Read via Zetaris at ${time(s.status.queriedAt)}`),
    el("div", { class: "stats" },
      el("div", {}, el("strong", {}, available.length), " available"),
      el("div", { class: soon.length ? "warn" : "" }, el("strong", {}, soon.length), " expire within 24h")),
  );
  if (s.units.length === 0) {
    card.append(el("p", { class: "empty" }, "No platelet units at this site."));
    return card;
  }
  const rows = s.units.map((u) => {
    const h = hoursLeft(u.expiresAt);
    return el("tr", { title: u.source },
      el("td", {}, u.unitId),
      el("td", {}, `${u.abo}${u.rh}`),
      el("td", { class: u.status === "available" && h <= 24 ? "warn" : "" }, h <= 0 ? "expired" : `${h}h`),
      el("td", {}, u.irradiated ? "Yes" : "No"),
      el("td", {}, el("span", { class: `badge ${u.status}` }, u.status), u.reservedFor ? ` for ${u.reservedFor}` : ""));
  });
  card.append(el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, "Unit"), el("th", {}, "Group"), el("th", {}, "Expires in"), el("th", {}, "Irradiated"), el("th", {}, "Status"))),
    el("tbody", {}, ...rows))));
  return card;
}

function render(data) {
  const down = data.sites.filter((s) => !s.status.ok).map((s) => s.site.name);
  if (!data.courier.status.ok) down.push("Courier");
  const status = $("#status");
  status.className = "status " + data.state;
  status.textContent =
    data.state === "loaded" ? "All sources live." :
    data.state === "partial" ? `Some sources unavailable: ${down.join(", ")}. Other sites are live.` :
    "No source could be read. Check that Zetaris and the sources are running.";

  $("#sites").replaceChildren(...data.sites.map(siteCard));

  const cs = data.courier.status;
  $("#courier-status").textContent = cs.ok ? `Read via Zetaris at ${time(cs.queriedAt)}` : `Unavailable. ${cs.error}`;
  $("#slots tbody").replaceChildren(...data.courier.slots.map((s) => el("tr", {},
    el("td", {}, s.slotId), el("td", {}, `${s.fromSite} to ${s.toSite}`), el("td", {}, time(s.departsAt)),
    el("td", {}, el("span", { class: `badge ${s.status}` }, s.status)), el("td", {}, s.bookingId ?? ""))));
}

async function load() {
  const btn = $("#refresh");
  btn.disabled = true;
  $("#status").className = "status loading";
  $("#status").textContent = "Loading live stock";
  try {
    const res = await fetch("/api/stock");
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    render(await res.json());
  } catch (err) {
    $("#status").className = "status error";
    $("#status").textContent = `Couldn't load stock: ${err.message}`;
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

function transferCard(t) {
  const e = t.evidence;
  return el("article", { class: "transfer" },
    el("div", { class: "transfer-head" },
      el("strong", {}, t.unitId), " ",
      el("span", { class: "tag" }, `${t.abo}${t.rh}${t.irradiated ? " irradiated" : ""}`), " ",
      el("span", { class: `badge ${t.state}` }, t.state)),
    el("p", {}, `${siteName(t.from)} to ${siteName(t.to)}, courier slot ${t.slotId}, arrives ${time(t.arrivesAt)}`),
    el("p", { class: "message" }, t.message),
    t.reason ? el("p", { class: "reason" }, t.reason) : "",
    el("p", { class: "source" }, `Source row: ${e.source}. Status ${e.status}, expires ${time(e.expiresAt)}, read ${time(e.queriedAt)}.`),
    el("p", { class: "source" }, t.messageBy === "nemotron" ? "Request written by Nemotron" : "Request from the standard template"));
}

function renderTransfers(transfers) {
  const shown = transfers.filter((t) => t.state !== "superseded");
  $("#transfers").replaceChildren(...(shown.length ? shown.map(transferCard) : [el("p", { class: "empty" }, "No transfers yet. Run the morning plan.")]));
  $("#send").hidden = !transfers.some((t) => t.state === "proposed");
}

function renderSummary(run) {
  const box = $("#plan-summary");
  box.hidden = false;
  const reduction = run.outdatesBefore ? Math.round((1 - run.outdatesAfter / run.outdatesBefore) * 100) : 0;
  box.replaceChildren(
    el("div", {}, el("strong", {}, run.outdatesBefore), " projected outdates without the plan"),
    el("div", {}, el("strong", {}, run.outdatesAfter), " with the plan", run.outdatesBefore ? ` (${reduction}% fewer)` : ""),
    el("div", {}, el("strong", {}, run.transfers.length), " transfers proposed"),
    el("p", { class: "source" }, "Projection from live stock and 30 days of usage history. Not a measured result."));
}

async function loadTransfers() {
  try {
    const res = await fetch("/api/transfers");
    renderTransfers((await res.json()).transfers);
  } catch (err) {
    planStatus("error", `Couldn't load transfers: ${err.message}`);
  }
}

$("#run-plan").addEventListener("click", async () => {
  const btn = $("#run-plan");
  btn.disabled = true;
  planStatus("loading", "Planning. Reading live stock and usage through Zetaris.");
  try {
    const run = await post("/api/plan");
    renderSummary(run);
    planStatus(run.modelNotice ? "partial" : "loaded",
      run.modelNotice ? `Planned without model. ${run.modelNotice}` :
      run.transfers.length ? "Planned." : "Planned. No transfer would prevent an outdate right now.");
    await loadTransfers();
    load();
  } catch (err) {
    planStatus("error", err.message);
  } finally {
    btn.disabled = false;
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
    planStatus("error", `Couldn't send: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

$("#refresh").addEventListener("click", load);
load();
loadTransfers();
