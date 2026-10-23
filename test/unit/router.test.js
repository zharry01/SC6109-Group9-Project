import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rankRoutes, PREFERENCES } from '../../src/core/router.js';

const cand = (id, feeUsd, latencySec, extra = {}) => ({
  rollupId: id,
  name: `Rollup ${id}`,
  health: 'healthy',
  feeUsd,
  latencySec,
  successProb: 0.95,
  blockers: [],
  ...extra,
});

// A: expensive + fast, B: cheap + slow, C: in between
const base = () => [cand('A', 0.07, 0.5), cand('B', 0.012, 2), cand('C', 0.028, 1)];

describe('rankRoutes', () => {
  test('cheapest policy picks the lowest fee', () => {
    const r = rankRoutes(base(), { preference: 'cheapest' });
    assert.equal(r.best.rollupId, 'B');
    assert.deepEqual(r.ranked.map((c) => c.rollupId), ['B', 'C', 'A']);
  });

  test('fastest policy picks the lowest latency', () => {
    const r = rankRoutes(base(), { preference: 'fastest' });
    assert.equal(r.best.rollupId, 'A');
  });

  test('balanced policy trades off cost and latency', () => {
    const r = rankRoutes(base(), { preference: 'balanced' });
    assert.equal(r.best.rollupId, 'C');
  });

  test('unknown preference falls back to balanced', () => {
    const r = rankRoutes(base(), { preference: 'yolo' });
    assert.equal(r.preference, 'balanced');
  });

  test('weights of every policy sum to 1', () => {
    for (const w of Object.values(PREFERENCES)) assert.ok(Math.abs(w.cost + w.latency + w.risk - 1) < 1e-9);
  });

  test('maxLatency constraint excludes slow rollups with a reason', () => {
    const r = rankRoutes(base(), { preference: 'cheapest', maxLatencySec: 1 });
    assert.equal(r.best.rollupId, 'C');
    const b = r.excluded.find((c) => c.rollupId === 'B');
    assert.match(b.reasons[0], /latency 2.0s exceeds your max 1s/);
  });

  test('routes expected to outlive the intent validity window are excluded', () => {
    const c = base();
    c[1].latencySec = 26; // B badly congested
    const r = rankRoutes(c, { preference: 'cheapest', validitySec: 12 });
    assert.notEqual(r.best.rollupId, 'B');
    assert.match(r.excluded[0].reasons[0], /outlive the intent's validity window \(12s\)/);
  });

  test('maxFee constraint excludes expensive rollups', () => {
    const r = rankRoutes(base(), { preference: 'fastest', maxFeeUsd: 0.03 });
    assert.equal(r.best.rollupId, 'C');
    assert.deepEqual(r.excluded.map((c) => c.rollupId), ['A']);
  });

  test('stalled / unreachable rollups are never chosen', () => {
    const c = base();
    c[1].health = 'stalled';
    c[1].successProb = 0;
    c[2].health = 'unreachable';
    const r = rankRoutes(c, { preference: 'cheapest' });
    assert.equal(r.best.rollupId, 'A');
    assert.equal(r.excluded.length, 2);
    assert.ok(r.explanation.some((l) => l.includes('stalled')));
  });

  test('blockers from quoting (e.g. insufficient balance) exclude a route', () => {
    const c = base();
    c[1].blockers = ['insufficient USDC balance'];
    const r = rankRoutes(c, { preference: 'cheapest' });
    assert.equal(r.best.rollupId, 'C');
  });

  test('low success probability excludes a route', () => {
    const c = base();
    c[1].successProb = 0.3;
    const r = rankRoutes(c, { preference: 'cheapest' });
    assert.notEqual(r.best.rollupId, 'B');
    assert.match(r.excluded[0].reasons[0], /success probability 30%/);
  });

  test('lower success probability is penalised via the risk term', () => {
    const c = [cand('X', 0.02, 1, { successProb: 0.95 }), cand('Y', 0.02, 1, { successProb: 0.7 })];
    const r = rankRoutes(c, { preference: 'balanced' });
    assert.equal(r.best.rollupId, 'X');
  });

  test('regression: a slightly better success history must not override a 2x fee gap', () => {
    // Observed in the live benchmark: C had 40 successes (p=0.983) vs B (p=0.95), and the
    // old worst-relative risk normalisation made "cheapest" pick C over a 56% cheaper B.
    const c = [cand('A', 0.07, 0.5), cand('B', 0.0122, 2), cand('C', 0.028, 1, { successProb: 59 / 60 })];
    const r = rankRoutes(c, { preference: 'cheapest' });
    assert.equal(r.best.rollupId, 'B');
  });

  test('no feasible route returns best = null and explains why', () => {
    const r = rankRoutes(base(), { maxFeeUsd: 0.001 });
    assert.equal(r.best, null);
    assert.equal(r.ranked.length, 0);
    assert.match(r.explanation[0], /No rollup can execute/);
    assert.equal(r.excluded.length, 3);
  });

  test('swaps: worse execution price counts as cost (shortfall)', () => {
    // B is cheaper in fees but returns $20 less output than A
    const c = [cand('A', 0.07, 0.5, { amountOutUsd: 1000 }), cand('B', 0.012, 0.5, { amountOutUsd: 980 })];
    const r = rankRoutes(c, { preference: 'cheapest' });
    assert.equal(r.best.rollupId, 'A');
    const b = r.ranked.find((x) => x.rollupId === 'B');
    assert.ok(Math.abs(b.shortfallUsd - 20) < 1e-9);
    assert.ok(Math.abs(b.effectiveCostUsd - 20.012) < 1e-9);
  });

  test('scores are deterministic with ties broken by latency then id', () => {
    const c = [cand('B', 0.02, 1), cand('A', 0.02, 1)];
    const r1 = rankRoutes(c, {});
    const r2 = rankRoutes([...c].reverse(), {});
    assert.equal(r1.best.rollupId, 'A');
    assert.equal(r2.best.rollupId, 'A');
  });

  test('explanation compares the winner with every alternative', () => {
    const r = rankRoutes(base(), { preference: 'cheapest' });
    assert.match(r.explanation[0], /Selected Rollup B using the "cheapest" policy/);
    assert.ok(r.explanation.some((l) => /vs Rollup A: \d+% cheaper, 1.5s slower/.test(l)));
  });

  test('single candidate works', () => {
    const r = rankRoutes([cand('A', 0.05, 1)], {});
    assert.equal(r.best.rollupId, 'A');
    assert.ok(r.best.score > 0);
  });
});
