import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEPLOYMENTS_FILE = path.join(ROOT, 'deployments.json');

/** Load a Foundry artifact (abi + bytecode) produced by `forge build`. */
export function loadArtifact(name) {
  const file = path.join(ROOT, 'out', `${name}.sol`, `${name}.json`);
  if (!existsSync(file)) throw new Error(`Missing artifact ${file}. Run "forge build" first.`);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export const settlementAbi = () => loadArtifact('IntentSettlement').abi;
export const erc20Abi = () => loadArtifact('MockERC20').abi;
export const ammAbi = () => loadArtifact('MiniAMM').abi;
