// One command for the whole demo: 3 Anvil rollups -> deploy contracts -> router server.
import { writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { ROLLUPS } from '../config/rollups.js';
import { ROOT, DEPLOYMENTS_FILE } from '../src/chain/artifacts.js';
import { startChains, deployAll } from '../src/chain/devnet.js';
import { startServer } from '../src/server.js';

if (!existsSync(path.join(ROOT, 'out', 'IntentSettlement.sol'))) {
  console.log('Compiling contracts (forge build)...');
  execSync('forge build', { cwd: ROOT, stdio: 'inherit' });
}

console.log('Starting 3 local rollups (Anvil)...');
const chains = await startChains(ROLLUPS, { log: (m) => process.stderr.write(m) });
const shutdown = () => {
  chains.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  console.log('Deploying MockERC20 (USDC, WETH), MiniAMM and IntentSettlement on each rollup...');
  const deployments = await deployAll(ROLLUPS);
  writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(deployments, null, 2));
  for (const p of ROLLUPS) {
    console.log(`  ${p.name} (chainId ${p.chainId}, ${p.blockTimeSec}s blocks, port ${p.port}) settlement=${deployments[p.id].settlement}`);
  }
  if (!existsSync(path.join(ROOT, 'results', 'sim-results.json'))) {
    execSync('node scripts/sim.js', { cwd: ROOT, stdio: 'ignore' });
  }
  const { url } = await startServer({ deployments });
  console.log(`\nIntent router UI ready: ${url}\nPress Ctrl+C to stop all chains.`);
} catch (err) {
  console.error(err);
  chains.stop();
  process.exit(1);
}
