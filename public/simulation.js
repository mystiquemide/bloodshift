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
const change = (x) => { const n = Math.round(x * 100); return n > 0 ? `+${n}%` : n < 0 ? `\u2212${-n}%` : "0%"; };

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
    $("#status").textContent = `Over ${s.runs} runs of ${s.days} days. Per-run reduction ranged from ${pct(s.outdateReductionRange[0])} to ${pct(s.outdateReductionRange[1])}.`;
    const stat = (big, small) => el("div", { class: "l-stat" }, el("strong", {}, big), el("span", {}, small));
    $("#summary").replaceChildren(
      stat(pct(s.outdateReduction), "fewer outdated units"),
      stat(`${one(s.noSharing.outdates)} → ${one(s.rule.outdates)}`, "outdates per run"),
      stat(`${one(s.noSharing.shortages)} → ${one(s.rule.shortages)}`, "shortages per run"),
      stat(one(s.rule.transfers), "transfers per run"));
    const groups = Object.keys(s.outdatesByGroup.noSharing).sort((a, b) => s.outdatesByGroup.noSharing[b] - s.outdatesByGroup.noSharing[a]);
    const max = Math.max(...groups.map((g) => s.outdatesByGroup.noSharing[g]));
    $("#groups tbody").replaceChildren(...groups.map((g) => {
      const before = s.outdatesByGroup.noSharing[g];
      const after = s.outdatesByGroup.rule[g] ?? 0;
      return el("tr", {}, el("td", {}, g), el("td", {}, bar(before, max, "before")), el("td", {}, bar(after, max, "after")),
        el("td", {}, before ? change(after / before - 1) : "-"));
    }));
  } catch (err) {
    const retry = el("button", { type: "button" }, "Try again");
    retry.addEventListener("click", () => {
      $("#summary").replaceChildren(el("div", { class: "l-stat pending" }, el("strong", {}, "Running"), el("span", {}, "the simulation")));
      $("#status").textContent = "";
      load();
    });
    $("#summary").replaceChildren(el("div", { class: "l-stat" }, el("strong", {}, "Not available"), el("span", {}, `Couldn't run the simulation. ${err instanceof TypeError ? "Bloodshift isn't reachable. Check your connection, then try again." : "Try again in a moment."}`)), retry);
  }
}

load();
