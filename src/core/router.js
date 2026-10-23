// Pure routing logic: hard constraints first, then a weighted score. No I/O here so it
// can be unit-tested and reused by the load simulator.

export const PREFERENCES = {
  cheapest: { cost: 0.7, latency: 0.2, risk: 0.1 },
  fastest: { cost: 0.2, latency: 0.7, risk: 0.1 },
  balanced: { cost: 0.45, latency: 0.4, risk: 0.15 },
};

export const MIN_SUCCESS_PROB = 0.5;

/**
 * @typedef {object} Candidate
 * @property {string} rollupId
 * @property {string} name
 * @property {string} health            healthy | degraded | stalled | unreachable
 * @property {number} feeUsd            relayer fee the user would pay
 * @property {number} latencySec        expected time to inclusion
 * @property {number} successProb       0..1
 * @property {number} [amountOutUsd]    swaps only: USD value of the expected output
 * @property {string[]} [blockers]      feasibility problems found while quoting
 *                                      (insufficient balance, slippage, no pool, RPC error...)
 */

/**
 * Rank candidate routes for one intent.
 * @param {Candidate[]} candidates
 * @param {{preference?: keyof PREFERENCES, maxFeeUsd?: number, maxLatencySec?: number, validitySec?: number}} constraints
 *        validitySec: system limit — a route expected to take longer than this would let the
 *        signed intent expire before inclusion, so it is not worth trying.
 */
export function rankRoutes(candidates, constraints = {}) {
  const preference = PREFERENCES[constraints.preference] ? constraints.preference : 'balanced';
  const weights = PREFERENCES[preference];

  // Swaps: a route that returns less output is "more expensive" by the shortfall.
  const outs = candidates.filter((c) => c.amountOutUsd != null && !(c.blockers?.length)).map((c) => c.amountOutUsd);
  const bestOutUsd = outs.length ? Math.max(...outs) : null;

  const evaluated = candidates.map((c) => {
    const shortfallUsd = bestOutUsd != null && c.amountOutUsd != null ? Math.max(0, bestOutUsd - c.amountOutUsd) : 0;
    const reasons = [...(c.blockers ?? [])];
    if (c.health === 'stalled') reasons.push('rollup is stalled (no new blocks)');
    if (c.health === 'unreachable') reasons.push('rollup RPC unreachable');
    if (constraints.maxFeeUsd != null && c.feeUsd > constraints.maxFeeUsd) {
      reasons.push(`fee $${fmt(c.feeUsd)} exceeds your max $${fmt(constraints.maxFeeUsd)}`);
    }
    if (constraints.maxLatencySec != null && c.latencySec > constraints.maxLatencySec) {
      reasons.push(`latency ${c.latencySec.toFixed(1)}s exceeds your max ${constraints.maxLatencySec}s`);
    }
    if (constraints.validitySec != null && c.latencySec > constraints.validitySec) {
      reasons.push(`expected latency ${c.latencySec.toFixed(1)}s would outlive the intent's validity window (${constraints.validitySec}s)`);
    }
    if (!reasons.length && c.successProb < MIN_SUCCESS_PROB) {
      reasons.push(`success probability ${(c.successProb * 100).toFixed(0)}% below ${MIN_SUCCESS_PROB * 100}%`);
    }
    return { ...c, shortfallUsd, effectiveCostUsd: c.feeUsd + shortfallUsd, reasons };
  });

  const feasible = evaluated.filter((c) => c.reasons.length === 0);
  const excluded = evaluated.filter((c) => c.reasons.length > 0);

  // Cost and latency are normalised by the worst feasible value (ratios are meaningful).
  // Risk uses an absolute scale: failure probability / max tolerated failure probability.
  // (Normalising risk by the worst candidate turned 5% vs 1.7% failure into 1.0 vs 0.33 and
  // let a rollup's own success history outweigh a 2x fee difference: a rich-get-richer loop.)
  const maxCost = Math.max(...feasible.map((c) => c.effectiveCostUsd), 1e-12);
  const maxLat = Math.max(...feasible.map((c) => c.latencySec), 1e-12);
  const riskScale = 1 - MIN_SUCCESS_PROB;

  const ranked = feasible
    .map((c) => {
      const components = {
        cost: weights.cost * (c.effectiveCostUsd / maxCost),
        latency: weights.latency * (c.latencySec / maxLat),
        risk: weights.risk * ((1 - c.successProb) / riskScale),
      };
      const score = components.cost + components.latency + components.risk;
      return { ...c, score, components };
    })
    .sort((a, b) => a.score - b.score || a.latencySec - b.latencySec || a.rollupId.localeCompare(b.rollupId));

  return {
    preference,
    weights,
    best: ranked[0] ?? null,
    ranked,
    excluded,
    explanation: explain(ranked, excluded, preference, constraints),
  };
}

function explain(ranked, excluded, preference, constraints) {
  const lines = [];
  if (!ranked.length) {
    lines.push('No rollup can execute this intent under the given constraints.');
  } else {
    const best = ranked[0];
    lines.push(`Selected ${best.name} using the "${preference}" policy (score ${best.score.toFixed(3)}, lower is better).`);
    for (const other of ranked.slice(1)) {
      lines.push(compare(best, other));
    }
    if (constraints.maxLatencySec != null) {
      lines.push(`Expected latency ${best.latencySec.toFixed(1)}s is within your ${constraints.maxLatencySec}s limit.`);
    }
  }
  for (const ex of excluded) lines.push(`${ex.name} excluded: ${ex.reasons.join('; ')}.`);
  return lines;
}

function compare(best, other) {
  const parts = [];
  const costDiff = other.effectiveCostUsd - best.effectiveCostUsd;
  if (Math.abs(costDiff) > 1e-9) {
    const pct = Math.abs(costDiff) / Math.max(best.effectiveCostUsd, other.effectiveCostUsd) * 100;
    parts.push(costDiff > 0 ? `${pct.toFixed(0)}% cheaper` : `${pct.toFixed(0)}% more expensive`);
  }
  const latDiff = other.latencySec - best.latencySec;
  if (Math.abs(latDiff) >= 0.05) {
    parts.push(latDiff > 0 ? `${latDiff.toFixed(1)}s faster` : `${(-latDiff).toFixed(1)}s slower`);
  }
  if (other.shortfallUsd > 0.005) parts.push(`$${fmt(other.shortfallUsd)} more swap output`);
  const verdict = parts.length ? parts.join(', ') : 'equivalent on cost and latency';
  return `vs ${other.name}: ${verdict} (their score ${other.score.toFixed(3)}).`;
}

const fmt = (x) => (x >= 1 ? x.toFixed(2) : x.toFixed(4));
