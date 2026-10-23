// End-to-end: real Anvil rollups + deployed contracts + router service + HTTP API.
// Uses ports 18545-18547 so it can run while the demo is up on 8545-8547.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashTypedData } from 'viem';
import { ROLLUPS, ROUTER } from '../../config/rollups.js';
import { startChains, deployAll } from '../../src/chain/devnet.js';
import { Rollup, sleep } from '../../src/chain/rollup.js';
import { IntentService } from '../../src/service.js';
import { createApp } from '../../src/server.js';
import { INTENT_TYPES, intentDomain, refHash, toUnits } from '../../src/core/intent.js';

const PROFILES = ROLLUPS.map((p) => ({ ...p, port: p.port + 10_000 }));
let chains, rollups, service, server, baseUrl;

const waitDone = async (rec) => {
  await rec.done;
  return service.view(rec);
};
const bal = (id, token, who) => service.rollups.get(id).balanceOf(token, service.accounts[who].address);

before(async () => {
  chains = await startChains(PROFILES);
  const deployments = await deployAll(PROFILES);
  rollups = PROFILES.map((p) => new Rollup(p, deployments[p.id]));
  await Promise.all(rollups.map((r) => r.startMonitor(400)));
  service = new IntentService(rollups);
  server = createApp(service).listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await sleep(1500); // let the monitors see a few blocks
});

after(() => {
  rollups?.forEach((r) => r.stopMonitor());
  server?.closeAllConnections?.();
  server?.close();
  chains?.stop();
});

describe('EIP-712 consistency', () => {
  test('router digest == on-chain IntentSettlement.hashIntent', async () => {
    const r = service.rollups.get('A');
    const intent = {
      kind: 1, user: service.accounts.alice.address, tokenIn: r.deployment.usdc, tokenOut: r.deployment.usdc,
      amountIn: 5n, minAmountOut: 5n, recipient: service.accounts.merchant.address, maxFee: 7n, nonce: 42n,
      deadline: 1_900_000_000n, ref: refHash('ORDER-9'),
    };
    const offchain = hashTypedData({ domain: intentDomain(r.profile.chainId, r.deployment.settlement), types: INTENT_TYPES, primaryType: 'Intent', message: intent });
    assert.equal(await r.hashIntent(intent), offchain);
  });
});

describe('routing + execution', () => {
  test('cheapest transfer goes to B, moves exact amounts, pays relayer', async () => {
    const before = { bob: await bal('B', 'usdc', 'bob'), alice: await bal('B', 'usdc', 'alice') };
    const rec = await waitDone(service.submit({ user: 'alice', kind: 'transfer', token: 'usdc', amount: 100, recipient: 'bob', preference: 'cheapest' }));
    assert.equal(rec.status, 'CONFIRMED', JSON.stringify(rec.timeline));
    assert.equal(rec.result.rollupId, 'B');
    const fee = toUnits(rec.attempts[0].fee, 'usdc');
    assert.equal((await bal('B', 'usdc', 'bob')) - before.bob, toUnits(100, 'usdc'));
    assert.equal(before.alice - (await bal('B', 'usdc', 'alice')), toUnits(100, 'usdc') + fee);
    assert.deepEqual(rec.timeline.map((e) => e.type), ['RECEIVED', 'ROUTED', 'SIGNED', 'SUBMITTED', 'CONFIRMED']);
  });

  test('rollup where the user lacks balance is excluded (Alice has 50 USDC on C)', async () => {
    const q = await service.quote({ user: 'alice', kind: 'transfer', amount: 100, recipient: 'bob', preference: 'balanced' });
    const c = q.excluded.find((x) => x.rollupId === 'C');
    assert.ok(c, 'C should be excluded');
    assert.match(c.reasons[0], /insufficient USDC balance/);
  });

  test('large swap avoids shallow pools and respects slippage bound', async () => {
    const before = await bal('A', 'weth', 'alice');
    const rec = await waitDone(service.submit({ user: 'alice', kind: 'swap', token: 'usdc', tokenOut: 'weth', amount: 3000, preference: 'cheapest' }));
    assert.equal(rec.status, 'CONFIRMED', JSON.stringify(rec.timeline));
    assert.equal(rec.result.rollupId, 'A');
    const minOut = BigInt(rec.attempts[0].intent.minAmountOut);
    assert.ok((await bal('A', 'weth', 'alice')) - before >= minOut);
    assert.ok(rec.routing.excluded.some((x) => x.rollupId === 'B' && x.reasons.some((m) => /liquidity|balance/.test(m))));
  });

  test('merchant payment carries the order reference on-chain', async () => {
    const rec = await waitDone(service.submit({ user: 'bob', kind: 'payment', amount: 12.5, recipient: 'merchant', ref: 'ORDER-777', preference: 'fastest' }));
    assert.equal(rec.status, 'CONFIRMED');
    assert.equal(rec.attempts[0].intent.ref, refHash('ORDER-777'));
    assert.equal(rec.result.amountOut, 12.5);
  });

  test('impossible constraints fail cleanly without sending a transaction', async () => {
    const rec = await waitDone(service.submit({ user: 'bob', kind: 'transfer', amount: 1, recipient: 'carol', maxFeeUsd: 0.0001 }));
    assert.equal(rec.status, 'FAILED');
    assert.equal(rec.attempts.length, 0);
    assert.match(rec.timeline.at(-1).message, /No feasible route/);
  });

  test('10 concurrent intents all confirm (relayer nonce management)', async () => {
    const recs = Array.from({ length: 10 }, (_, i) =>
      service.submit({ user: 'bob', kind: 'transfer', amount: 1 + i, recipient: 'carol', preference: 'fastest' }),
    );
    const done = await Promise.all(recs.map(waitDone));
    assert.deepEqual(done.map((r) => r.status), Array(10).fill('CONFIRMED'));
  });
});

describe('adaptivity', () => {
  test('congestion on A pushes "fastest" intents elsewhere', async () => {
    await sleep(1500); // let monitors drop the previous test's (now mined) backlog
    const q0 = await service.quote({ user: 'bob', kind: 'transfer', amount: 1, recipient: 'carol', preference: 'fastest' });
    const brief = (q) => JSON.stringify(q.all.map((c) => ({ id: c.rollupId, h: c.health, fee: c.feeUsd, lat: c.latencySec, p: c.successProb, b: c.blockers })));
    assert.equal(q0.best.rollupId, 'A', brief(q0));
    const r = service.rollups.get('A');
    await r.congest(Math.round((8 * r.profile.blockGasLimit) / 21_000), 2);
    await sleep(900);
    const q1 = await service.quote({ user: 'bob', kind: 'transfer', amount: 1, recipient: 'carol', preference: 'fastest' });
    const a = q1.all.find((c) => c.rollupId === 'A');
    assert.ok(a.latencySec > 3, `A latency estimate should rise, got ${a.latencySec}`);
    assert.ok(a.feeUsd > q0.all.find((c) => c.rollupId === 'A').feeUsd, 'A fee estimate should rise');
    assert.notEqual(q1.best.rollupId, 'A');
  });

  test('sequencer outage after signing: safe re-route, no double execution', async () => {
    // Wait for A's spam backlog to clear so it is a sane fallback, then target C explicitly.
    await sleep(3000);
    const carolOnC = await bal('C', 'usdc', 'carol');
    const rec = await waitDone(
      service.submit({ user: 'bob', kind: 'transfer', amount: 3, recipient: 'carol', preference: 'balanced', forceRollup: 'C', simulateOutage: true }),
    );
    assert.equal(rec.status, 'CONFIRMED', JSON.stringify(rec.timeline));
    assert.equal(rec.attempts.length, 2);
    assert.equal(rec.attempts[0].rollupId, 'C');
    assert.equal(rec.attempts[0].status, 'TIMEOUT');
    assert.notEqual(rec.result.rollupId, 'C');
    assert.ok(rec.timeline.some((e) => e.type === 'CHAOS'));
    assert.ok(rec.result.endToEndSec >= ROUTER.intentTtlSec);

    // While halted the router must not pick C.
    const q = await service.quote({ user: 'bob', kind: 'transfer', amount: 1, recipient: 'carol', preference: 'cheapest' });
    assert.ok(q.excluded.some((x) => x.rollupId === 'C' && /stalled/.test(x.reasons.join())));

    // Resume C: the stale fill gets mined but must revert (Expired) -> carol not paid twice.
    const c = service.rollups.get('C');
    await c.resume();
    const receipt = await c.client.waitForTransactionReceipt({ hash: rec.attempts[0].txHash, timeout: 15_000 });
    assert.equal(receipt.status, 'reverted');
    assert.equal(await bal('C', 'usdc', 'carol'), carolOnC);
  });
});

describe('HTTP API', () => {
  test('quote, submit, stats and validation errors', async () => {
    const post = (p, body) => fetch(baseUrl + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const q = await (await post('/api/quote', { user: 'carol', kind: 'transfer', amount: 2, recipient: 'bob' })).json();
    assert.ok(q.best);
    const bad = await post('/api/quote', { user: 'carol', kind: 'transfer', amount: -2, recipient: 'bob' });
    assert.equal(bad.status, 400);
    const rec = await (await post('/api/intents', { user: 'carol', kind: 'transfer', amount: 2, recipient: 'bob' })).json();
    await service.intents.get(rec.id).done;
    const got = await (await fetch(`${baseUrl}/api/intents/${rec.id}`)).json();
    assert.equal(got.status, 'CONFIRMED');
    const stats = await (await fetch(`${baseUrl}/api/stats`)).json();
    assert.ok(stats.confirmed >= 15);
    assert.ok(stats.rerouted >= 1);
    const rollupList = await (await fetch(`${baseUrl}/api/rollups`)).json();
    assert.equal(rollupList.length, 3);
  });
});
