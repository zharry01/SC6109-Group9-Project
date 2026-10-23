// One connected rollup: live monitoring, read helpers, the relayer's nonce-managed
// submission queue, and "chaos" controls used in the demo (congestion / outage).
import { createPublicClient, createWalletClient, defineChain, http, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ACCOUNTS, ETH_USD, ROUTER, rpcUrl } from '../../config/rollups.js';
import { estimateCostAndLatency, congestionLevel, successProbability } from '../core/feeModel.js';
import { settlementAbi, erc20Abi, ammAbi } from './artifacts.js';

const DEFAULT_GAS = { transfer: 95_000, payment: 95_000, swap: 150_000 };

export function chainFor(profile, host) {
  return defineChain({
    id: profile.chainId,
    name: profile.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl(profile, host)] } },
  });
}

export class Rollup {
  /**
   * @param {object} profile    entry of config ROLLUPS (port may be overridden)
   * @param {object} deployment { usdc, weth, amm, settlement }
   */
  constructor(profile, deployment, { host = '127.0.0.1' } = {}) {
    this.profile = profile;
    this.id = profile.id;
    this.deployment = deployment;
    this.chain = chainFor(profile, host);
    const transport = http(rpcUrl(profile, host), { timeout: 4_000, retryCount: 0 });
    this.client = createPublicClient({ chain: this.chain, transport, pollingInterval: 250 });
    this.relayer = createWalletClient({ chain: this.chain, transport, account: privateKeyToAccount(ACCOUNTS.relayer) });
    this.spammer = createWalletClient({ chain: this.chain, transport, account: privateKeyToAccount(ACCOUNTS.spammer) });
    this.abis = { settlement: settlementAbi(), erc20: erc20Abi(), amm: ammAbi() };

    this.metrics = {
      health: 'unknown',
      blockNumber: 0,
      blockTimestamp: 0,
      baseFeeWei: 0,
      utilization: 0,
      pendingTx: 0,
      backlogGas: 0,
      congestion: 0,
      lagSec: 0,
      halted: false,
      updatedAt: 0,
    };
    this.outcomes = { successes: 0, failures: 0 };
    this.gasEwma = { ...DEFAULT_GAS };
    this._utilHistory = new Map(); // blockNumber -> gasUsed / gasLimit
    this._relayerNonce = null;
    this._sendQueue = Promise.resolve();
    this._spamNonce = null;
    this.calldataBytes = this._fillCalldataBytes();
  }

  // ------------------------------------------------------------------ monitoring

  async poll() {
    try {
      const [block, pool] = await Promise.all([
        this.client.getBlock({ blockTag: 'latest' }),
        this.client.request({ method: 'txpool_content', params: [] }),
      ]);
      let pendingTx = 0;
      let backlogGas = 0;
      for (const byNonce of Object.values(pool.pending ?? {})) {
        for (const tx of Object.values(byNonce)) {
          pendingTx += 1;
          backlogGas += Number(BigInt(tx.gas));
        }
      }
      const num = Number(block.number);
      this._utilHistory.set(num, Number(block.gasUsed) / Number(block.gasLimit));
      for (const k of this._utilHistory.keys()) if (k < num - 4) this._utilHistory.delete(k);
      const utils = [...this._utilHistory.values()];
      const utilization = utils.reduce((a, b) => a + b, 0) / utils.length;

      const lagSec = Math.max(0, Date.now() / 1000 - Number(block.timestamp));
      const bt = this.profile.blockTimeSec;
      let health = 'healthy';
      if (lagSec > Math.max(ROUTER.stallFactor * bt, 4)) health = 'stalled';
      else if (lagSec > bt * 1.5 + 1) health = 'degraded';

      Object.assign(this.metrics, {
        health,
        blockNumber: num,
        blockTimestamp: Number(block.timestamp),
        baseFeeWei: Number(block.baseFeePerGas ?? 0n),
        utilization,
        pendingTx,
        backlogGas,
        congestion: congestionLevel({ utilization, backlogGas, blockGasLimit: this.profile.blockGasLimit }),
        lagSec,
        updatedAt: Date.now(),
      });
    } catch (err) {
      Object.assign(this.metrics, { health: 'unreachable', error: err.shortMessage ?? err.message, updatedAt: Date.now() });
    }
    return this.metrics;
  }

  startMonitor(intervalMs = 1000) {
    this.stopMonitor();
    this._timer = setInterval(() => this.poll(), intervalMs);
    return this.poll();
  }

  stopMonitor() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  successProb() {
    return successProbability({ ...this.outcomes, health: this.metrics.health });
  }

  /** Fee/latency estimate for a fill of the given kind under current conditions. */
  estimate(kind) {
    return estimateCostAndLatency({
      gas: this.gasEwma[kind],
      calldataBytes: this.calldataBytes,
      baseFeeWei: this.metrics.baseFeeWei,
      priorityFeeGwei: this.profile.priorityFeeGwei,
      l1FeeGweiPerByte: this.profile.l1FeeGweiPerByte,
      ethUsd: ETH_USD,
      blockTimeSec: this.profile.blockTimeSec,
      blockGasLimit: this.profile.blockGasLimit,
      backlogGas: this.metrics.backlogGas,
    });
  }

  recordOutcome(ok, { kind, gasUsed } = {}) {
    if (ok) this.outcomes.successes += 1;
    else this.outcomes.failures += 1;
    if (ok && kind && gasUsed) this.gasEwma[kind] = Math.round(0.7 * this.gasEwma[kind] + 0.3 * gasUsed);
  }

  snapshot() {
    return {
      id: this.id,
      ...this.profile,
      metrics: { ...this.metrics },
      successProb: this.successProb(),
      outcomes: { ...this.outcomes },
      estimate: { transfer: this.estimate('transfer'), swap: this.estimate('swap') },
      deployment: this.deployment,
    };
  }

  // ------------------------------------------------------------------ reads

  tokenAddress(token) {
    return this.deployment[token];
  }

  async balanceAndAllowance(token, owner) {
    const address = this.tokenAddress(token);
    const [balance, allowance] = await Promise.all([
      this.client.readContract({ address, abi: this.abis.erc20, functionName: 'balanceOf', args: [owner] }),
      this.client.readContract({
        address,
        abi: this.abis.erc20,
        functionName: 'allowance',
        args: [owner, this.deployment.settlement],
      }),
    ]);
    return { balance, allowance };
  }

  async balanceOf(token, owner) {
    return this.client.readContract({ address: this.tokenAddress(token), abi: this.abis.erc20, functionName: 'balanceOf', args: [owner] });
  }

  async quoteSwap(tokenIn, amountIn) {
    return this.client.readContract({
      address: this.deployment.amm,
      abi: this.abis.amm,
      functionName: 'getAmountOut',
      args: [this.tokenAddress(tokenIn), amountIn],
    });
  }

  async hashIntent(intent) {
    return this.client.readContract({
      address: this.deployment.settlement,
      abi: this.abis.settlement,
      functionName: 'hashIntent',
      args: [intent],
    });
  }

  // ------------------------------------------------------------------ relayer

  /**
   * Pre-flight (eth_estimateGas, which reverts if the fill would revert) and broadcast
   * `fill` from the relayer account. Submissions are serialised per rollup so the
   * relayer's nonces never collide.
   */
  submitFill(intent, signature, fee) {
    const run = async () => {
      const args = [intent, signature, fee];
      const gas = await this.client.estimateContractGas({
        address: this.deployment.settlement,
        abi: this.abis.settlement,
        functionName: 'fill',
        args,
        account: this.relayer.account,
      });
      if (this._relayerNonce == null) {
        this._relayerNonce = await this.client.getTransactionCount({ address: this.relayer.account.address, blockTag: 'pending' });
      }
      const baseFee = BigInt(this.metrics.baseFeeWei || 1);
      const tip = BigInt(Math.round(this.profile.priorityFeeGwei * 1e9));
      try {
        const hash = await this.relayer.writeContract({
          address: this.deployment.settlement,
          abi: this.abis.settlement,
          functionName: 'fill',
          args,
          gas: (gas * 12n) / 10n,
          nonce: this._relayerNonce,
          maxPriorityFeePerGas: tip,
          maxFeePerGas: baseFee * 3n + tip,
        });
        this._relayerNonce += 1;
        return { hash, gasEstimate: Number(gas) };
      } catch (err) {
        this._relayerNonce = null; // resync from chain next time
        throw err;
      }
    };
    const p = this._sendQueue.then(run, run);
    this._sendQueue = p.catch(() => {});
    return p;
  }

  /** Poll for a receipt until `untilMs` (wall clock). Returns null on timeout. */
  async waitReceipt(hash, untilMs) {
    while (Date.now() < untilMs) {
      try {
        const receipt = await this.client.getTransactionReceipt({ hash });
        if (receipt) return receipt;
      } catch {
        // not mined yet (or RPC hiccup)
      }
      await sleep(250);
    }
    return null;
  }

  // ------------------------------------------------------------------ chaos controls (demo only)

  /**
   * Flood the sequencer with `count` plain transfers from a spammer account and spike
   * the base fee, emulating a popular app launching on this rollup.
   */
  async congest(count = 300, baseFeeGwei = 0.5) {
    await this.client.request({
      method: 'anvil_setNextBlockBaseFeePerGas',
      params: [`0x${BigInt(Math.round(baseFeeGwei * 1e9)).toString(16)}`],
    });
    if (this._spamNonce == null) {
      this._spamNonce = await this.client.getTransactionCount({ address: this.spammer.account.address, blockTag: 'pending' });
    }
    const start = this._spamNonce;
    this._spamNonce += count;
    const to = privateKeyToAccount(ACCOUNTS.deployer).address;
    const sends = [];
    for (let i = 0; i < count; i++) {
      sends.push(
        this.spammer.sendTransaction({
          to,
          value: 1n,
          gas: 21_000n,
          nonce: start + i,
          maxFeePerGas: 50_000_000_000n, // generous cap so spam never gets stuck in the pool
          maxPriorityFeePerGas: 1_000_000_000n,
        }),
      );
      if (sends.length >= 50) await Promise.allSettled(sends.splice(0));
    }
    const results = await Promise.allSettled(sends);
    if (results.some((r) => r.status === 'rejected')) this._spamNonce = null;
    return { sent: count };
  }

  async halt() {
    await this.client.request({ method: 'evm_setIntervalMining', params: [0] });
    this.metrics.halted = true;
  }

  async resume() {
    await this.client.request({ method: 'evm_setIntervalMining', params: [this.profile.blockTimeSec] });
    this.metrics.halted = false;
  }

  // ------------------------------------------------------------------ internals

  _fillCalldataBytes() {
    const zero = '0x0000000000000000000000000000000000000000';
    const data = encodeFunctionData({
      abi: this.abis.settlement,
      functionName: 'fill',
      args: [
        {
          kind: 0,
          user: zero,
          tokenIn: zero,
          tokenOut: zero,
          amountIn: 0n,
          minAmountOut: 0n,
          recipient: zero,
          maxFee: 0n,
          nonce: 0n,
          deadline: 0n,
          ref: `0x${'0'.repeat(64)}`,
        },
        `0x${'11'.repeat(65)}`,
        0n,
      ],
    });
    return (data.length - 2) / 2;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
