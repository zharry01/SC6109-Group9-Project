// Local devnet orchestration: start one Anvil per rollup profile, deploy the contracts,
// fund the demo users, then switch each chain to its rollup-specific block time.
import { spawn } from 'node:child_process';
import { createPublicClient, createWalletClient, http, parseUnits, maxUint256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ACCOUNTS, USER_BALANCES, TOKENS, rpcUrl } from '../../config/rollups.js';
import { loadArtifact } from './artifacts.js';
import { chainFor, sleep } from './rollup.js';

/** Start Anvil for each profile. Chains start in automine mode so deployment is instant. */
export async function startChains(profiles, { log = () => {} } = {}) {
  const procs = [];
  for (const p of profiles) {
    const args = [
      '--port', String(p.port),
      '--chain-id', String(p.chainId),
      '--gas-limit', '30000000', // large for deployment; reduced to the rollup capacity afterwards
      '--base-fee', '1000000', // 0.001 gwei initial base fee
      '--order', 'fifo', // first-come-first-served sequencer
      '--silent',
    ];
    const proc = spawn('anvil', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', (d) => log(`[anvil ${p.id}] ${d}`));
    proc.on('error', (err) => log(`[anvil ${p.id}] failed to start: ${err.message}`));
    procs.push(proc);
  }
  await Promise.all(profiles.map((p) => waitForRpc(rpcUrl(p))));
  return {
    procs,
    stop: () => procs.forEach((proc) => proc.kill('SIGTERM')),
  };
}

async function waitForRpc(url, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error(`Anvil at ${url} did not start (is the port already in use?)`);
}

/** Deploy tokens, AMM and settlement on one rollup and fund the demo users. */
export async function deployRollup(profile) {
  const chain = chainFor(profile);
  const transport = http(rpcUrl(profile));
  const client = createPublicClient({ chain, transport, pollingInterval: 50 });
  const wallet = (key) => createWalletClient({ chain, transport, account: privateKeyToAccount(key) });
  const deployer = wallet(ACCOUNTS.deployer);
  const relayerAddr = privateKeyToAccount(ACCOUNTS.relayer).address;

  const deploy = async (name, args = []) => {
    const { abi, bytecode } = loadArtifact(name);
    const hash = await deployer.deployContract({ abi, bytecode, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    return receipt.contractAddress;
  };
  const send = async (w, address, name, functionName, args) => {
    const hash = await w.writeContract({ address, abi: loadArtifact(name).abi, functionName, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} failed on ${profile.id}`);
  };

  const usdc = await deploy('MockERC20', ['USD Coin', 'USDC', 6]);
  const weth = await deploy('MockERC20', ['Wrapped Ether', 'WETH', 18]);
  const amm = await deploy('MiniAMM', [usdc, weth]);
  const settlement = await deploy('IntentSettlement');

  await send(deployer, settlement, 'IntentSettlement', 'setRelayer', [relayerAddr, true]);
  await send(deployer, settlement, 'IntentSettlement', 'setPool', [usdc, weth, amm]);

  const u = (amount, token) => parseUnits(String(amount), TOKENS[token].decimals);
  const me = deployer.account.address;
  await send(deployer, usdc, 'MockERC20', 'mint', [me, u(profile.pool.usdc, 'usdc')]);
  await send(deployer, weth, 'MockERC20', 'mint', [me, u(profile.pool.weth, 'weth')]);
  await send(deployer, usdc, 'MockERC20', 'approve', [amm, maxUint256]);
  await send(deployer, weth, 'MockERC20', 'approve', [amm, maxUint256]);
  await send(deployer, amm, 'MiniAMM', 'addLiquidity', [u(profile.pool.usdc, 'usdc'), u(profile.pool.weth, 'weth')]);

  for (const [name, perRollup] of Object.entries(USER_BALANCES)) {
    const bal = perRollup[profile.id];
    const user = wallet(ACCOUNTS[name]);
    await send(deployer, usdc, 'MockERC20', 'mint', [user.account.address, u(bal.usdc, 'usdc')]);
    await send(deployer, weth, 'MockERC20', 'mint', [user.account.address, u(bal.weth, 'weth')]);
    // One-time approval of the settlement contract (in production: Permit2 / smart-account session keys).
    await send(user, usdc, 'MockERC20', 'approve', [settlement, maxUint256]);
    await send(user, weth, 'MockERC20', 'approve', [settlement, maxUint256]);
  }

  // Switch to rollup-style operation: limited block capacity, interval block production.
  await client.request({ method: 'evm_setBlockGasLimit', params: [`0x${profile.blockGasLimit.toString(16)}`] });
  await client.request({ method: 'evm_setAutomine', params: [false] });
  await client.request({ method: 'evm_setIntervalMining', params: [profile.blockTimeSec] });

  return { chainId: profile.chainId, rpc: rpcUrl(profile), usdc, weth, amm, settlement };
}

export async function deployAll(profiles) {
  const out = {};
  await Promise.all(
    profiles.map(async (p) => {
      out[p.id] = await deployRollup(p);
    }),
  );
  return out;
}
