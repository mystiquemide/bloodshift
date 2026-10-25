// Live strip: a real count from the live read. Hidden when the read fails, never a stale number.
const strip = document.querySelector("#live-strip");
if (strip) {
  fetch("/api/stock")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((stock) => {
      const live = stock.sites.filter((s) => s.status.ok);
      const units = live.reduce((n, s) => n + s.units.filter((u) => u.status === "available" && Date.parse(u.expiresAt) > Date.now()).length, 0);
      if (!live.length) return;
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = "Live";
      const text = document.createTextNode(` ${units} platelet ${units === 1 ? "unit" : "units"} available across ${live.length} ${live.length === 1 ? "hospital" : "hospitals"}, read through Zetaris just now. `);
      const link = document.createElement("a");
      link.href = "/app";
      link.textContent = "Open the network";
      strip.replaceChildren(chip, text, link);
      strip.hidden = false;
    })
    .catch(() => { strip.hidden = true; });
}
