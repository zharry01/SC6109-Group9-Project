// EIP-712 definition of the Intent struct. Must match IntentSettlement.INTENT_TYPEHASH.
import { keccak256, toHex, parseUnits, formatUnits } from 'viem';
import { TOKENS } from '../../config/rollups.js';

export const KIND = { transfer: 0, payment: 1, swap: 2 };
export const KIND_NAME = ['transfer', 'payment', 'swap'];

export const INTENT_TYPES = {
  Intent: [
    { name: 'kind', type: 'uint8' },
    { name: 'user', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'ref', type: 'bytes32' },
  ],
};

export function intentDomain(chainId, settlement) {
  return { name: 'CrossRollupIntentSettlement', version: '1', chainId, verifyingContract: settlement };
}

export const refHash = (text) => (text ? keccak256(toHex(text)) : `0x${'0'.repeat(64)}`);

export const toUnits = (amount, token) => parseUnits(String(amount), TOKENS[token].decimals);
export const fromUnits = (units, token) => Number(formatUnits(units, TOKENS[token].decimals));
export const usdToUnits = (usd, token) => toUnits((usd / TOKENS[token].usd).toFixed(TOKENS[token].decimals), token);
export const unitsToUsd = (units, token) => fromUnits(units, token) * TOKENS[token].usd;

let nonceCounter = 0n;
/** Unordered nonce: time-based with a counter, unique per process. */
export function freshNonce() {
  nonceCounter += 1n;
  return BigInt(Date.now()) * 1_000_000n + nonceCounter;
}

/**
 * Validate and normalise an API request into an intent request.
 * Throws an Error with a user-facing message when invalid.
 */
export function normaliseRequest(body, { users, resolveRecipient }) {
  const kind = String(body.kind ?? 'transfer').toLowerCase();
  if (!(kind in KIND)) throw new Error(`Unknown intent kind "${body.kind}"`);
  const user = String(body.user ?? '').toLowerCase();
  if (!users[user]) throw new Error(`Unknown user "${body.user}"`);
  const token = String(body.token ?? 'usdc').toLowerCase();
  if (!TOKENS[token]) throw new Error(`Unsupported token "${body.token}"`);
  let tokenOut = token;
  if (kind === 'swap') {
    tokenOut = String(body.tokenOut ?? (token === 'usdc' ? 'weth' : 'usdc')).toLowerCase();
    if (!TOKENS[tokenOut]) throw new Error(`Unsupported token "${body.tokenOut}"`);
    if (tokenOut === token) throw new Error('Swap needs two different tokens');
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be a positive number');

  const recipientKey = kind === 'swap' ? (body.recipient || user) : body.recipient;
  const recipient = resolveRecipient(recipientKey);
  if (!recipient) throw new Error(`Unknown recipient "${body.recipient}"`);

  const optNum = (v) => (v === '' || v == null ? undefined : Number(v));
  const maxFeeUsd = optNum(body.maxFeeUsd);
  const maxLatencySec = optNum(body.maxLatencySec);
  if (maxFeeUsd != null && !(maxFeeUsd > 0)) throw new Error('Max fee must be positive');
  if (maxLatencySec != null && !(maxLatencySec > 0)) throw new Error('Max latency must be positive');

  return {
    kind,
    user,
    token,
    tokenOut,
    amount,
    recipientKey: String(recipientKey),
    recipient,
    preference: ['cheapest', 'fastest', 'balanced'].includes(body.preference) ? body.preference : 'balanced',
    maxFeeUsd,
    maxLatencySec,
    slippageBps: Math.min(Math.max(Number(body.slippageBps ?? 50), 0), 5000),
    maxPriceImpactPct: Number(body.maxPriceImpactPct ?? 2),
    ref: kind === 'payment' ? String(body.ref ?? '') : '',
    forceRollup: body.forceRollup || undefined,
    simulateOutage: Boolean(body.simulateOutage),
    noReroute: Boolean(body.noReroute), // benchmark baselines: a static policy never falls back
  };
}
