import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCostAndLatency, congestionLevel, successProbability, effectiveGasPriceWei } from '../../src/core/feeModel.js';

const params = (o = {}) => ({
  gas: 100_000,
  calldataBytes: 500,
  baseFeeWei: 0,
  priorityFeeGwei: 0.05,
  l1FeeGweiPerByte: 30,
  ethUsd: 3000,
  blockTimeSec: 2,
  blockGasLimit: 1_000_000,
  backlogGas: 0,
  ...o,
});

describe('fee model', () => {
  test('L2 fee = gas * (base fee + tip), L1 fee = bytes * DA price', () => {
    const e = estimateCostAndLatency(params({ baseFeeWei: 1e9 }));
    // 100k gas * 1.05 gwei = 1.05e-4 ETH = $0.315
    assert.ok(Math.abs(e.l2FeeUsd - 0.315) < 1e-9);
    // 500 bytes * 30 gwei = 1.5e-5 ETH = $0.045
    assert.ok(Math.abs(e.l1FeeUsd - 0.045) < 1e-9);
    assert.ok(Math.abs(e.totalFeeUsd - 0.36) < 1e-9);
  });

  test('effective gas price adds the tip to the base fee', () => {
    assert.equal(effectiveGasPriceWei(2e9, 0.5), 2.5e9);
  });

  test('empty sequencer: latency is half a block on average', () => {
    assert.equal(estimateCostAndLatency(params()).latencySec, 1);
  });

  test('backlog adds one block of latency per full block of queued gas', () => {
    const e = estimateCostAndLatency(params({ backlogGas: 3_500_000 }));
    assert.equal(e.backlogBlocks, 3);
    assert.equal(e.latencySec, 2 * 3.5);
  });

  test('fee increases monotonically with base fee', () => {
    const fees = [0, 1e8, 1e9, 1e10].map((b) => estimateCostAndLatency(params({ baseFeeWei: b })).totalFeeUsd);
    for (let i = 1; i < fees.length; i++) assert.ok(fees[i] > fees[i - 1]);
  });

  test('congestion is the max of utilisation and backlog pressure, clamped to 1', () => {
    assert.equal(congestionLevel({ utilization: 0.4, backlogGas: 0, blockGasLimit: 1e6 }), 0.4);
    assert.equal(congestionLevel({ utilization: 0.1, backlogGas: 2.5e6, blockGasLimit: 1e6 }), 0.5);
    assert.equal(congestionLevel({ utilization: 0.1, backlogGas: 50e6, blockGasLimit: 1e6 }), 1);
  });

  test('success probability: 95% prior, learns from outcomes, zero when stalled', () => {
    assert.equal(successProbability({}), 0.95);
    assert.ok(successProbability({ failures: 10 }) < 0.7);
    assert.ok(successProbability({ successes: 100 }) > 0.99);
    assert.equal(successProbability({ health: 'stalled' }), 0);
    assert.equal(successProbability({ health: 'unreachable' }), 0);
    assert.ok(Math.abs(successProbability({ health: 'degraded' }) - 0.57) < 1e-9);
  });
});
