// Pure fee / latency model shared by the live router and the load simulator.
//
// Rollup cost = L2 execution fee + L1 data-availability fee:
//   L2 fee  = gas * (current EIP-1559 base fee + sequencer priority fee)
//   L1 fee  = calldata bytes * DA price per byte        (modelled, Anvil has no L1)
// Inclusion latency with a block every `blockTimeSec` seconds and a FIFO sequencer:
//   wait for the next block (on average half a block) + one block per full block of
//   pending gas queued ahead of us.

const GWEI = 1e9;

/** Effective gas price (wei, as Number) a fill pays on this rollup right now. */
export function effectiveGasPriceWei(baseFeeWei, priorityFeeGwei) {
  return baseFeeWei + priorityFeeGwei * GWEI;
}

/**
 * @param {object} p
 * @param {number} p.gas               estimated gas of the fill
 * @param {number} p.calldataBytes     size of the fill calldata
 * @param {number} p.baseFeeWei        current L2 base fee
 * @param {number} p.priorityFeeGwei   sequencer priority fee (tip)
 * @param {number} p.l1FeeGweiPerByte  DA cost per byte
 * @param {number} p.ethUsd
 * @param {number} p.blockTimeSec
 * @param {number} p.blockGasLimit
 * @param {number} p.backlogGas        gas of transactions already queued at the sequencer
 */
export function estimateCostAndLatency(p) {
  const gasPriceWei = effectiveGasPriceWei(p.baseFeeWei, p.priorityFeeGwei);
  const l2FeeEth = (p.gas * gasPriceWei) / 1e18;
  const l1FeeEth = (p.calldataBytes * p.l1FeeGweiPerByte) / GWEI;
  const l2FeeUsd = l2FeeEth * p.ethUsd;
  const l1FeeUsd = l1FeeEth * p.ethUsd;

  const backlogBlocks = Math.floor(Math.max(0, p.backlogGas) / p.blockGasLimit);
  const latencySec = p.blockTimeSec * (0.5 + backlogBlocks);

  return {
    gasPriceWei,
    l2FeeUsd,
    l1FeeUsd,
    totalFeeUsd: l2FeeUsd + l1FeeUsd,
    backlogBlocks,
    latencySec,
  };
}

/** 0..1 congestion indicator from recent block utilisation and the queued backlog. */
export function congestionLevel({ utilization, backlogGas, blockGasLimit }) {
  const backlogLoad = Math.min(1, backlogGas / (blockGasLimit * 5)); // 5 full blocks queued => 1.0
  return Math.min(1, Math.max(utilization ?? 0, backlogLoad));
}

/**
 * Success probability: Beta prior (19 successes : 1 failure, i.e. 95%) updated with the
 * router's own observed outcomes on this rollup, scaled by current health.
 */
export function successProbability({ successes = 0, failures = 0, health = 'healthy' }) {
  const healthFactor = { healthy: 1, degraded: 0.6, stalled: 0, unreachable: 0 }[health] ?? 0;
  return ((successes + 19) / (successes + failures + 20)) * healthFactor;
}
