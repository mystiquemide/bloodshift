const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c ?? "")));
  return node;
}

const pct = (x) => `${Math.round(x * 100)}%`;
const one = (x) => x.toFixed(1);

function bar(value, max, kind) {
  return el("div", { class: "bar-cell" },
    el("span", { class: `bar ${kind}`, style: `width:${max ? (value / max) * 100 : 0}%` }),
    el("span", { class: "bar-label" }, one(value)));
}

async function load() {
  try {
    const res = await fetch("/api/simulation");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();
    $("#status").className = "status loaded";
    $("#status").textContent = `${s.runs} runs of ${s.days} days each.`;
    $("#summary").replaceChildren(
      el("div", {}, el("strong", {}, pct(s.outdateReduction)), " fewer outdated units with the rule"),
      el("div", {}, el("strong", {}, `${one(s.noSharing.outdates)} → ${one(s.rule.outdates)}`), " outdates per run"),
      el("div", {}, el("strong", {}, `${one(s.noSharing.shortages)} → ${one(s.rule.shortages)}`), " shortages per run"),
      el("div", {}, el("strong", {}, one(s.rule.transfers)), " transfers per run"),
      el("p", { class: "source" }, `Per-run reduction ranged from ${pct(s.outdateReductionRange[0])} to ${pct(s.outdateReductionRange[1])}.`));
    const groups = Object.keys(s.outdatesByGroup.noSharing).sort((a, b) => s.outdatesByGroup.noSharing[b] - s.outdatesByGroup.noSharing[a]);
    const max = Math.max(...groups.map((g) => s.outdatesByGroup.noSharing[g]));
    $("#groups tbody").replaceChildren(...groups.map((g) => {
      const before = s.outdatesByGroup.noSharing[g];
      const after = s.outdatesByGroup.rule[g] ?? 0;
      return el("tr", {}, el("td", {}, g), el("td", {}, bar(before, max, "before")), el("td", {}, bar(after, max, "after")),
        el("td", {}, before ? `${Math.round((after / before - 1) * 100)}%` : "-"));
    }));
  } catch (err) {
    $("#status").className = "status error";
    $("#status").textContent = `Couldn't run the simulation: ${err.message}`;
  }
}

load();
