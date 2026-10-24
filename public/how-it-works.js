// Live counters. A counter whose source fails is left out rather than shown with a made-up number.
const box = document.querySelector("#counters");

function counter(value, label) {
  const div = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = String(value);
  div.append(strong, ` ${label}`);
  return div;
}

const plural = (n, one, many) => (n === 1 ? one : many);

const get = (path) => fetch(path).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));

const [stock, transfers, declines] = await Promise.allSettled([get("/api/stock"), get("/api/transfers"), get("/api/declines")]);
const items = [];
if (stock.status === "fulfilled") {
  const live = stock.value.sites.filter((s) => s.status.ok);
  const units = live.reduce((n, s) => n + s.units.length, 0);
  items.push(counter(units, `${plural(units, "unit", "units")} read live from ${live.length} hospital ${plural(live.length, "system", "systems")}`));
}
if (transfers.status === "fulfilled") {
  const t = transfers.value.transfers.filter((x) => x.state !== "superseded");
  const reserved = t.filter((x) => x.state === "reserved").length;
  items.push(counter(t.length, plural(t.length, "transfer recorded", "transfers recorded")));
  items.push(counter(reserved, plural(reserved, "reserved at its source", "reserved at their source")));
}
if (declines.status === "fulfilled") {
  const n = declines.value.declines.length;
  items.push(counter(n, plural(n, "decline reason remembered", "decline reasons remembered")));
}
box.replaceChildren(...items);
