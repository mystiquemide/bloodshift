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

$("#refresh").addEventListener("click", load);
load();
