// Run the offline load simulation and write results/sim-results.{json,md}.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/chain/artifacts.js';
import { runSweep } from '../src/sim/simulator.js';

const t0 = Date.now();
const res = runSweep();
const dir = path.join(ROOT, 'results');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'sim-results.json'), JSON.stringify(res, null, 2));

const f = (x, d = 2) => (x == null ? '-' : x.toFixed(d));
let md = `# Load simulation results\n\nGenerated ${res.generatedAt}. Intent TTL ${res.params.ttl}s, user max fee $${res.params.maxFeeUsd}, ${res.params.duration}s of arrivals per run.\n\n`;
md += `Raw capacity (fills/s if a rollup were empty): ${Object.entries(res.params.capacityFillsPerSec).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(', ')}; background load uses ${Object.entries(res.params.background).map(([k, v]) => `${k} ${v * 100}%`).join(', ')}.\n\n`;
md += `## Experiment 1: load sweep\n\n| strategy | λ (intents/s) | throughput | fail rate | avg latency (s) | p95 latency (s) | avg fee ($) |\n|---|---|---|---|---|---|---|\n`;
for (const s of res.strategies) {
  for (const row of res.sweep[s]) {
    if (![2, 6, 10, 14, 20].includes(row.lambda)) continue;
    md += `| ${s} | ${row.lambda} | ${f(row.throughput)} | ${f(row.failRate * 100, 1)}% | ${f(row.avgLatency)} | ${f(row.p95Latency)} | ${f(row.avgFeeUsd, 4)} |\n`;
  }
}
md += `\n## Experiment 2: incident (B background traffic ×4.5 at 30–60s, C halted at 75–100s, λ=${res.params.incidentLambda})\n\n| strategy | fail rate | avg latency (s) | p95 latency (s) | avg fee ($) | share of confirmed |\n|---|---|---|---|---|---|\n`;
for (const s of res.strategies) {
  const r = res.incident[s];
  md += `| ${s} | ${f(r.failRate * 100, 1)}% | ${f(r.avgLatency)} | ${f(r.p95Latency)} | ${f(r.avgFeeUsd, 4)} | ${Object.entries(r.share).map(([k, v]) => `${k}:${v}`).join(' ')} |\n`;
}
writeFileSync(path.join(dir, 'sim-results.md'), md);
console.log(md);
console.log(`done in ${Date.now() - t0} ms -> results/sim-results.json, results/sim-results.md`);
