// Live benchmark on real Anvil rollups: router vs. static "always X" policies.
// Starts its own chains on ports 28545-28547, so it can run next to the demo.
// Usage: node scripts/bench-live.js [rate1,rate2] [seconds]
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROLLUPS } from '../config/rollups.js';
import { ROOT } from '../src/chain/artifacts.js';
import { startChains, deployAll } from '../src/chain/devnet.js';
import { Rollup, sleep } from '../src/chain/rollup.js';
import { loadArtifact } from '../src/chain/artifacts.js';
import { createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ACCOUNTS } from '../config/rollups.js';
import { IntentService } from '../src/service.js';

const RATES = (process.argv[2] ?? '4,12,20').split(',').map(Number);
const SECONDS = Number(process.argv[3] ?? 10);
const POLICIES = [
  { name: 'router: balanced', body: { preference: 'balanced' } },
  { name: 'router: cheapest', body: { preference: 'cheapest' } },
  { name: 'always A', body: { forceRollup: 'A', noReroute: true } },
  { name: 'always B', body: { forceRollup: 'B', noReroute: true } },
  { name: 'always C', body: { forceRollup: 'C', noReroute: true } },
];

const profiles = ROLLUPS.map((p) => ({ ...p, port: p.port + 20_000 }));
console.log('Starting benchmark chains...');
const chains = await startChains(profiles);
process.on('SIGINT', () => { chains.stop(); process.exit(1); });
const deployments = await deployAll(profiles);
const rollups = profiles.map((p) => new Rollup(p, deployments[p.id]));
await Promise.all(rollups.map((r) => r.startMonitor(400)));
const service = new IntentService(rollups);

// Top up the two benchmark senders so balances never limit the experiment.
for (const r of rollups) {
  const deployer = createWalletClient({ chain: r.chain, transport: http(r.chain.rpcUrls.default.http[0]), account: privateKeyToAccount(ACCOUNTS.deployer) });
  for (const who of ['bob', 'carol']) {
    const hash = await deployer.writeContract({ address: r.deployment.usdc, abi: loadArtifact('MockERC20').abi, functionName: 'mint', args: [service.accounts[who].address, parseUnits('100000', 6)] });
    await r.client.waitForTransactionReceipt({ hash });
  }
}
await sleep(1500);

const idle = async () => {
  for (let i = 0; i < 120; i++) {
    await Promise.all(rollups.map((r) => r.poll()));
    if (rollups.every((r) => r.metrics.pendingTx === 0)) return;
    await sleep(500);
  }
};

const rows = [];
for (const rate of RATES) {
  for (const policy of POLICIES) {
    await idle();
    await sleep(2000); // let base fees settle
    const recs = [];
    const n = Math.round(rate * SECONDS);
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      const user = i % 2 ? 'bob' : 'carol';
      recs.push(service.submit({ user, kind: 'transfer', token: 'usdc', amount: 1 + (i % 3), recipient: user === 'bob' ? 'carol' : 'bob', ...policy.body }));
      await sleep(Math.max(0, t0 + ((i + 1) * 1000) / rate - Date.now()));
    }
    await Promise.all(recs.map((r) => r.done));
    const ok = recs.filter((r) => r.status === 'CONFIRMED');
    const lat = ok.map((r) => r.result.endToEndSec).sort((a, b) => a - b);
    const share = {};
    for (const r of ok) share[r.result.rollupId] = (share[r.result.rollupId] ?? 0) + 1;
    const row = {
      rate,
      policy: policy.name,
      intents: n,
      confirmed: ok.length,
      successRate: ok.length / n,
      avgLatencySec: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
      p95LatencySec: lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : null,
      avgFeeUsd: ok.length ? ok.reduce((a, r) => a + r.result.feeChargedUsd, 0) / ok.length : null,
      share,
      sampleDecision: recs[0].routing?.explanation ?? null,
    };
    rows.push(row);
    console.log(`${rate}/s ${policy.name.padEnd(17)} ok ${ok.length}/${n}  avg ${row.avgLatencySec?.toFixed(2)}s  p95 ${row.p95LatencySec?.toFixed(2)}s  fee $${row.avgFeeUsd?.toFixed(4)}  ${JSON.stringify(share)}`);
  }
}

rollups.forEach((r) => r.stopMonitor());
chains.stop();

const f = (x, d = 2) => (x == null ? '-' : x.toFixed(d));
let md = `# Live benchmark (real Anvil rollups)\n\nGenerated ${new Date().toISOString()}. ${SECONDS}s of transfer intents per run; static policies have re-routing disabled.\n\n| load (intents/s) | policy | confirmed | success | avg end-to-end (s) | p95 (s) | avg fee ($) | executed on |\n|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
  md += `| ${r.rate} | ${r.policy} | ${r.confirmed}/${r.intents} | ${f(r.successRate * 100, 0)}% | ${f(r.avgLatencySec)} | ${f(r.p95LatencySec)} | ${f(r.avgFeeUsd, 4)} | ${Object.entries(r.share).map(([k, v]) => `${k}:${v}`).join(' ')} |\n`;
}
mkdirSync(path.join(ROOT, 'results'), { recursive: true });
writeFileSync(path.join(ROOT, 'results', 'live-bench.json'), JSON.stringify(rows, null, 2));
writeFileSync(path.join(ROOT, 'results', 'live-bench.md'), md);
console.log(`\n${md}\nSaved results/live-bench.{json,md}`);
process.exit(0);
