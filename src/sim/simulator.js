// Discrete-time load simulator for the scalability analysis.
//
// Models every rollup as a FIFO sequencer that produces a block every `blockTimeSec`
// with a gas limit, an EIP-1559 base fee, and its own background traffic. Intents arrive
// as a Poisson process and are assigned to a rollup by a routing strategy. The router
// strategies call exactly the same `rankRoutes` + fee model as the live system.
import { ROLLUPS, ETH_USD } from '../../config/rollups.js';
import { estimateCostAndLatency, effectiveGasPriceWei } from '../core/feeModel.js';
import { rankRoutes } from '../core/router.js';

const INTENT_GAS = 120_000;
const BG_GAS = 50_000;
const CALLDATA_BYTES = 548;
const MIN_BASE_FEE = 1_000_000; // 0.001 gwei
const DT = 0.05;
const GWEI_TIP = 1e7; // 0.01 gwei headroom on top of 3x base fee

export const STRATEGIES = ['always A', 'always B', 'always C', 'round-robin', 'router: cheapest', 'router: balanced'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(rate, rand) {
  // Knuth; fine for the small rate*DT values used here
  const L = Math.exp(-rate);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rand();
  } while (p > L);
  return k - 1;
}

/**
 * @param {object} o
 * @param {string} o.strategy
 * @param {number} o.lambda       intents per second
 * @param {number} [o.duration]   seconds of arrivals
 * @param {number} [o.ttl]        intent deadline (s)
 * @param {object} [o.background] fraction of each rollup's capacity used by other users
 * @param {Array}  [o.events]     {rollupId, from, to, bgMultiplier?, halt?}
 * @param {boolean}[o.timeline]   record a per-second latency timeline
 * @param {number} [o.maxFeeUsd]  user fee cap per intent
 */
export function simulate({
  strategy,
  lambda,
  duration = 120,
  ttl = 15,
  seed = 7,
  profiles = ROLLUPS,
  background = { A: 0.3, B: 0.2, C: 0.4 },
  events = [],
  timeline = false,
  maxFeeUsd = 0.5,
}) {
  const rand = mulberry32(seed);
  const rs = profiles.map((p) => ({
    p,
    queue: [],
    baseFee: MIN_BASE_FEE,
    nextBlock: p.blockTimeSec * rand(),
    lastBlockAt: 0,
    bgRate: ((background[p.id] ?? 0) * p.blockGasLimit) / p.blockTimeSec / BG_GAS,
  }));
  const results = [];
  let rr = 0;
  let intentId = 0;
  const end = duration + ttl + 10;

  const active = (r, t, key) => events.find((e) => e.rollupId === r.p.id && t >= e.from && t < e.to && e[key] != null);

  const choose = (t) => {
    if (strategy.startsWith('always ')) return rs.find((r) => r.p.id === strategy.slice(7));
    if (strategy === 'round-robin') return rs[rr++ % rs.length];
    const pref = strategy.split(': ')[1];
    const candidates = rs.map((r) => {
      const backlogGas = r.queue.reduce((s, x) => s + x.gas, 0);
      const est = estimateCostAndLatency({
        gas: INTENT_GAS,
        calldataBytes: CALLDATA_BYTES,
        baseFeeWei: r.baseFee,
        priorityFeeGwei: r.p.priorityFeeGwei,
        l1FeeGweiPerByte: r.p.l1FeeGweiPerByte,
        ethUsd: ETH_USD,
        blockTimeSec: r.p.blockTimeSec,
        blockGasLimit: r.p.blockGasLimit,
        backlogGas,
      });
      const stalled = t - r.lastBlockAt > Math.max(3 * r.p.blockTimeSec, 4);
      return {
        rollupId: r.p.id,
        name: r.p.name,
        health: stalled ? 'stalled' : 'healthy',
        feeUsd: est.totalFeeUsd,
        latencySec: est.latencySec,
        successProb: stalled ? 0 : 0.95,
      };
    });
    // Same rule as the live router: skip routes expected to outlive the intent's deadline.
    const { best } = rankRoutes(candidates, { preference: pref, validitySec: ttl * 0.8, maxFeeUsd });
    return best ? rs.find((r) => r.p.id === best.rollupId) : null;
  };

  for (let t = 0; t < end; t += DT) {
    for (const r of rs) {
      const spike = active(r, t, 'bgMultiplier');
      const n = poisson(r.bgRate * (spike ? spike.bgMultiplier : 1) * DT, rand);
      // Background users are price-sensitive: each has its own absolute gas-price limit.
      for (let i = 0; i < n; i++) {
        const willing = (0.02 + 0.98 * rand()) * 1e9;
        r.queue.push({ gas: BG_GAS, bg: true, arrival: t, maxFee: Math.min(3 * r.baseFee + GWEI_TIP, willing) });
      }
    }
    if (t < duration) {
      const n = poisson(lambda * DT, rand);
      for (let i = 0; i < n; i++) {
        const id = intentId++;
        const r = choose(t);
        if (!r) {
          results.push({ id, t, ok: false, reason: 'no-route' });
          continue;
        }
        // The relayer bids at most 3x base fee, and never more than the user's max fee allows.
        const l1Usd = (CALLDATA_BYTES * r.p.l1FeeGweiPerByte * ETH_USD) / 1e9;
        const userCap = (((maxFeeUsd - l1Usd) / ETH_USD) * 1e18) / INTENT_GAS;
        r.queue.push({ gas: INTENT_GAS, id, arrival: t, deadline: t + ttl, rollupId: r.p.id, maxFee: Math.min(3 * r.baseFee + GWEI_TIP, userCap) });
      }
    }
    for (const r of rs) {
      if (t < r.nextBlock) continue;
      r.nextBlock += r.p.blockTimeSec;
      if (active(r, t, 'halt')) continue; // sequencer down: no block
      r.lastBlockAt = t;
      let used = 0;
      const keep = [];
      for (let i = 0; i < r.queue.length; i++) {
        const tx = r.queue[i];
        // Not includable at the current base fee (or the block is full): stays pending.
        // Intents past their deadline are dropped by the relayer; stale background txs are abandoned.
        const includable = tx.maxFee >= r.baseFee && used + tx.gas <= r.p.blockGasLimit;
        if (!includable) {
          if (tx.bg ? t - tx.arrival < 60 : t <= tx.deadline) keep.push(tx);
          else if (!tx.bg) results.push({ id: tx.id, t: tx.arrival, ok: false, reason: 'expired' });
          continue;
        }
        used += tx.gas;
        if (tx.bg) continue;
        const ok = t <= tx.deadline;
        const feeUsd =
          ((INTENT_GAS * effectiveGasPriceWei(r.baseFee, r.p.priorityFeeGwei)) / 1e18 +
            (CALLDATA_BYTES * r.p.l1FeeGweiPerByte) / 1e9) *
          ETH_USD;
        results.push({ id: tx.id, t: tx.arrival, ok, latency: t - tx.arrival, feeUsd, rollupId: r.p.id, reason: ok ? null : 'expired' });
      }
      r.queue = keep;
      // EIP-1559 base fee update (target = 50% of the gas limit).
      const target = r.p.blockGasLimit / 2;
      r.baseFee = Math.max(MIN_BASE_FEE, r.baseFee * (1 + ((used - target) / target) / 8));
    }
  }
  for (const r of rs) {
    for (const tx of r.queue) if (!tx.bg) results.push({ id: tx.id, t: tx.arrival, ok: false, reason: 'expired' });
  }

  return summarise(results, duration, timeline);
}

function summarise(results, duration, withTimeline) {
  const ok = results.filter((r) => r.ok);
  const lat = ok.map((r) => r.latency).sort((a, b) => a - b);
  const share = {};
  for (const r of ok) share[r.rollupId] = (share[r.rollupId] ?? 0) + 1;
  const out = {
    submitted: results.length,
    confirmed: ok.length,
    throughput: ok.length / duration,
    failRate: results.length ? 1 - ok.length / results.length : 0,
    avgLatency: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
    p95Latency: lat.length ? lat[Math.floor(lat.length * 0.95)] : null,
    avgFeeUsd: ok.length ? ok.reduce((a, r) => a + r.feeUsd, 0) / ok.length : null,
    share,
  };
  if (withTimeline) {
    const buckets = [];
    for (let s = 0; s < duration; s += 5) {
      const inB = results.filter((r) => r.t >= s && r.t < s + 5);
      const okB = inB.filter((r) => r.ok);
      buckets.push({
        t: s,
        avgLatency: okB.length ? okB.reduce((a, r) => a + r.latency, 0) / okB.length : null,
        failRate: inB.length ? 1 - okB.length / inB.length : 0,
        avgFeeUsd: okB.length ? okB.reduce((a, r) => a + r.feeUsd, 0) / okB.length : null,
      });
    }
    out.timeline = buckets;
  }
  return out;
}

/** Experiment 1: load sweep. Experiment 2: congestion spike on A + outage on C. */
export function runSweep({ lambdas = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20], duration = 120 } = {}) {
  const sweep = {};
  for (const strategy of STRATEGIES) {
    sweep[strategy] = lambdas.map((lambda) => ({ lambda, ...simulate({ strategy, lambda, duration }) }));
  }
  const incidentEvents = [
    { rollupId: 'B', from: 30, to: 60, bgMultiplier: 4.5 },
    { rollupId: 'C', from: 75, to: 100, halt: true },
  ];
  const incident = {};
  for (const strategy of STRATEGIES) {
    incident[strategy] = simulate({ strategy, lambda: 5, duration: 120, events: incidentEvents, timeline: true });
  }
  return {
    generatedAt: new Date().toISOString(),
    params: {
      intentGas: INTENT_GAS,
      calldataBytes: CALLDATA_BYTES,
      background: { A: 0.3, B: 0.2, C: 0.4 },
      duration,
      ttl: 15,
      maxFeeUsd: 0.5,
      incidentEvents,
      incidentLambda: 5,
      capacityFillsPerSec: Object.fromEntries(ROLLUPS.map((p) => [p.id, p.blockGasLimit / INTENT_GAS / p.blockTimeSec])),
    },
    strategies: STRATEGIES,
    lambdas,
    sweep,
    incident,
  };
}
