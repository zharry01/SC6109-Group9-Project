import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../../src/sim/simulator.js';

describe('load simulator', () => {
  test('is deterministic for a given seed', () => {
    const a = simulate({ strategy: 'router: balanced', lambda: 5, duration: 30 });
    const b = simulate({ strategy: 'router: balanced', lambda: 5, duration: 30 });
    assert.deepEqual(a, b);
  });

  test('every submitted intent is accounted for (confirmed or failed)', () => {
    const r = simulate({ strategy: 'round-robin', lambda: 8, duration: 30 });
    assert.ok(r.submitted > 0);
    assert.ok(r.confirmed <= r.submitted);
    const shareTotal = Object.values(r.share).reduce((a, b) => a + b, 0);
    assert.equal(shareTotal, r.confirmed);
  });

  test('light load: every strategy confirms everything', () => {
    for (const strategy of ['always A', 'always B', 'router: balanced']) {
      const r = simulate({ strategy, lambda: 1, duration: 30 });
      assert.equal(r.failRate, 0, strategy);
    }
  });

  test('a single rollup saturates; the router spreads load and keeps confirming', () => {
    const single = simulate({ strategy: 'always B', lambda: 12, duration: 60 });
    const router = simulate({ strategy: 'router: balanced', lambda: 12, duration: 60 });
    assert.ok(single.failRate > 0.3, `always B fail rate ${single.failRate}`);
    assert.ok(router.failRate < 0.02, `router fail rate ${router.failRate}`);
    assert.ok(router.throughput > 2 * single.throughput);
    assert.ok(Object.keys(router.share).length >= 2);
  });

  test('router avoids a halted rollup', () => {
    const events = [{ rollupId: 'C', from: 10, to: 50, halt: true }];
    const stat = simulate({ strategy: 'always C', lambda: 2, duration: 60, events });
    const router = simulate({ strategy: 'router: cheapest', lambda: 2, duration: 60, events });
    assert.ok(stat.failRate > 0.3);
    assert.ok(router.failRate < 0.05);
  });

  test('cheapest policy pays less on average than fastest-leaning static choice', () => {
    const cheap = simulate({ strategy: 'router: cheapest', lambda: 3, duration: 60 });
    const a = simulate({ strategy: 'always A', lambda: 3, duration: 60 });
    assert.ok(cheap.avgFeeUsd < a.avgFeeUsd / 2);
  });
});
