import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toHex, hashTypedData } from 'viem';
import { normaliseRequest, INTENT_TYPES, intentDomain, refHash, usdToUnits, toUnits, freshNonce } from '../../src/core/intent.js';

const ctx = {
  users: { alice: {}, bob: {} },
  resolveRecipient: (k) => ({ bob: '0x00000000000000000000000000000000000000b0', alice: '0x00000000000000000000000000000000000000a1' })[String(k).toLowerCase()] ?? null,
};

describe('normaliseRequest', () => {
  test('valid transfer with defaults', () => {
    const r = normaliseRequest({ user: 'Alice', kind: 'transfer', amount: '10', recipient: 'bob' }, ctx);
    assert.equal(r.user, 'alice');
    assert.equal(r.token, 'usdc');
    assert.equal(r.tokenOut, 'usdc');
    assert.equal(r.preference, 'balanced');
    assert.equal(r.slippageBps, 50);
    assert.equal(r.maxFeeUsd, undefined);
  });

  test('swap defaults recipient to the user and picks the other token', () => {
    const r = normaliseRequest({ user: 'alice', kind: 'swap', token: 'usdc', amount: 1 }, ctx);
    assert.equal(r.tokenOut, 'weth');
    assert.equal(r.recipient, '0x00000000000000000000000000000000000000a1');
  });

  for (const [name, body, msg] of [
    ['unknown user', { user: 'mallory', amount: 1, recipient: 'bob' }, /Unknown user/],
    ['negative amount', { user: 'alice', amount: -1, recipient: 'bob' }, /positive/],
    ['NaN amount', { user: 'alice', amount: 'abc', recipient: 'bob' }, /positive/],
    ['unknown kind', { user: 'alice', kind: 'bridge', amount: 1, recipient: 'bob' }, /Unknown intent kind/],
    ['unknown token', { user: 'alice', token: 'doge', amount: 1, recipient: 'bob' }, /Unsupported token/],
    ['unknown recipient', { user: 'alice', amount: 1, recipient: 'nobody' }, /Unknown recipient/],
    ['swap same token', { user: 'alice', kind: 'swap', token: 'usdc', tokenOut: 'usdc', amount: 1 }, /two different tokens/],
    ['zero max fee', { user: 'alice', amount: 1, recipient: 'bob', maxFeeUsd: 0 }, /Max fee/],
  ]) {
    test(`rejects ${name}`, () => assert.throws(() => normaliseRequest(body, ctx), msg));
  }

  test('slippage is clamped to [0, 5000] bps', () => {
    assert.equal(normaliseRequest({ user: 'alice', kind: 'swap', amount: 1, slippageBps: 99999 }, ctx).slippageBps, 5000);
  });
});

describe('EIP-712 encoding', () => {
  test('type string matches the Solidity INTENT_TYPEHASH', () => {
    const typeString = `Intent(${INTENT_TYPES.Intent.map((f) => `${f.type} ${f.name}`).join(',')})`;
    assert.equal(
      typeString,
      'Intent(uint8 kind,address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,address recipient,uint256 maxFee,uint256 nonce,uint256 deadline,bytes32 ref)',
    );
  });

  test('domain binds chainId and verifying contract (different rollup => different digest)', () => {
    const message = {
      kind: 0, user: '0x00000000000000000000000000000000000000a1', tokenIn: '0x0000000000000000000000000000000000000001',
      tokenOut: '0x0000000000000000000000000000000000000001', amountIn: 1n, minAmountOut: 1n,
      recipient: '0x00000000000000000000000000000000000000b0', maxFee: 0n, nonce: 1n, deadline: 1n, ref: refHash(''),
    };
    const s = '0x00000000000000000000000000000000000000c0';
    const d1 = hashTypedData({ domain: intentDomain(901, s), types: INTENT_TYPES, primaryType: 'Intent', message });
    const d2 = hashTypedData({ domain: intentDomain(902, s), types: INTENT_TYPES, primaryType: 'Intent', message });
    assert.notEqual(d1, d2);
  });

  test('ref hash: empty => zero, otherwise keccak of the text', () => {
    assert.equal(refHash(''), `0x${'0'.repeat(64)}`);
    assert.equal(refHash('ORDER-1'), keccak256(toHex('ORDER-1')));
  });
});

describe('units', () => {
  test('USD to token units', () => {
    assert.equal(usdToUnits(1.5, 'usdc'), 1_500_000n);
    assert.equal(usdToUnits(3000, 'weth'), 10n ** 18n);
    assert.equal(toUnits(0.1, 'weth'), 10n ** 17n);
  });

  test('nonces are unique', () => {
    const set = new Set(Array.from({ length: 1000 }, freshNonce));
    assert.equal(set.size, 1000);
  });
});
