// Start the 3 rollups and deploy, without the web server (for `npm start` in another terminal).
import { writeFileSync } from 'node:fs';
import { ROLLUPS } from '../config/rollups.js';
import { DEPLOYMENTS_FILE } from '../src/chain/artifacts.js';
import { startChains, deployAll } from '../src/chain/devnet.js';

const chains = await startChains(ROLLUPS, { log: (m) => process.stderr.write(m) });
process.on('SIGINT', () => { chains.stop(); process.exit(0); });
const deployments = await deployAll(ROLLUPS);
writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(deployments, null, 2));
console.log(JSON.stringify(deployments, null, 2));
console.log('Chains running. Ctrl+C to stop.');
