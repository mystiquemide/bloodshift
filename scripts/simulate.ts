// Runs the 30-day simulation over several seeds and prints the comparison.
// Simulated data only. Results are a supporting check, not a measured outcome.
import { writeFileSync, mkdirSync } from "node:fs";
import { compare } from "../src/simulation.js";

const runs = Number(process.argv[2] ?? 20);
const seeds = Array.from({ length: runs }, (_, i) => 1000 + i);
const s = compare(seeds);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const n = (x: number) => x.toFixed(1);

console.log(`Simulation: ${s.runs} runs x ${s.days} days, 3 sites, same demand and supply draws for both policies.`);
console.log(`No sharing:  ${n(s.noSharing.outdates)} outdates, ${n(s.noSharing.shortages)} shortages, ${n(s.noSharing.supplied)} supplied (mean per run)`);
console.log(`Rule:        ${n(s.rule.outdates)} outdates, ${n(s.rule.shortages)} shortages, ${n(s.rule.supplied)} supplied, ${n(s.rule.transfers)} transfers`);
console.log(`Outdates ${pct(s.outdateReduction)} lower with the rule (per-run range ${pct(s.outdateReductionRange[0])} to ${pct(s.outdateReductionRange[1])}).`);

mkdirSync("data", { recursive: true });
writeFileSync("data/simulation.json", JSON.stringify({ generatedAt: new Date().toISOString(), ...s }, null, 2));
console.log("Full results written to data/simulation.json");
