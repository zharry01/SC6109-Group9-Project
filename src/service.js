// Intent service: quote -> route -> sign -> relay -> confirm, with safe re-routing.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isAddress, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ACCOUNTS, ROUTER, TOKENS, ETH_USD } from '../config/rollups.js';
import { rankRoutes } from './core/router.js';
import {
  KIND,
  INTENT_TYPES,
  intentDomain,
  refHash,
  toUnits,
  fromUnits,
  usdToUnits,
  unitsToUsd,
  freshNonce,
  normaliseRequest,
} from './core/intent.js';
import { sleep } from './chain/rollup.js';

const DEMO_USERS = ['alice', 'bob', 'carol'];
const NAMED = ['alice', 'bob', 'carol', 'merchant'];

export class IntentService extends EventEmitter {
  /** @param {import('./chain/rollup.js').Rollup[]} rollups */
  constructor(rollups) {
    super();
    this.setMaxListeners(100);
    this.rollups = new Map(rollups.map((r) => [r.id, r]));
    this.accounts = Object.fromEntries(NAMED.map((n) => [n, privateKeyToAccount(ACCOUNTS[n])]));
    this.users = Object.fromEntries(DEMO_USERS.map((n) => [n, this.accounts[n]]));
    this.intents = new Map();
  }

  resolveRecipient = (key) => {
    if (key == null || key === '') return null;
    const k = String(key).toLowerCase();
    if (this.accounts[k]) return this.accounts[k].address;
    return isAddress(key) ? key : null;
  };

  normalise(body) {
    const req = normaliseRequest(body, { users: this.users, resolveRecipient: this.resolveRecipient });
    if (req.forceRollup && !this.rollups.has(req.forceRollup)) throw new Error(`Unknown rollup "${req.forceRollup}"`);
    return req;
  }

  // ---------------------------------------------------------------- quoting

  /** Build one routing candidate per rollup with live fee/latency/feasibility data. */
  async buildCandidates(req, { skip = new Set() } = {}) {
    const owner = this.users[req.user].address;
    const amountIn = toUnits(req.amount, req.token);
    const list = [...this.rollups.values()].filter((r) => !skip.has(r.id));

    return Promise.all(
      list.map(async (r) => {
        const est = r.estimate(req.kind);
        const feeUsd = est.totalFeeUsd * (1 + ROUTER.relayerMargin);
        const feeUnits = usdToUnits(feeUsd, req.token);
        const cand = {
          rollupId: r.id,
          name: r.profile.name,
          label: r.profile.label,
          health: r.metrics.health,
          congestion: r.metrics.congestion,
          backlogBlocks: est.backlogBlocks,
          feeUsd,
          l1FeeUsd: est.l1FeeUsd * (1 + ROUTER.relayerMargin),
          l2FeeUsd: est.l2FeeUsd * (1 + ROUTER.relayerMargin),
          feeUnits,
          latencySec: est.latencySec,
          successProb: r.successProb(),
          blockers: [],
        };
        if (cand.health === 'stalled' || cand.health === 'unreachable') return cand;
        try {
          const { balance, allowance } = await r.balanceAndAllowance(req.token, owner);
          const need = amountIn + feeUnits;
          if (balance < need) {
            cand.blockers.push(
              `insufficient ${TOKENS[req.token].symbol} balance (${fmtTok(balance, req.token)} < ${fmtTok(need, req.token)} incl. fee)`,
            );
          } else if (allowance < need) {
            cand.blockers.push('settlement contract not approved for this token');
          }
          cand.balance = fromUnits(balance, req.token);
          if (req.kind === 'swap') {
            const out = await r.quoteSwap(req.token, amountIn);
            cand.amountOut = out;
            cand.amountOutHuman = fromUnits(out, req.tokenOut);
            cand.amountOutUsd = unitsToUsd(out, req.tokenOut);
            const inUsd = req.amount * TOKENS[req.token].usd;
            cand.priceImpactPct = Math.max(0, (1 - cand.amountOutUsd / inUsd) * 100);
            if (cand.priceImpactPct > req.maxPriceImpactPct) {
              cand.blockers.push(
                `insufficient pool liquidity: price impact ${cand.priceImpactPct.toFixed(2)}% > ${req.maxPriceImpactPct}%`,
              );
            }
          }
        } catch (err) {
          cand.blockers.push(`quote failed: ${err.shortMessage ?? err.message}`);
        }
        return cand;
      }),
    );
  }

  async quote(body) {
    const req = this.normalise(body);
    const candidates = await this.buildCandidates(req);
    return stripBig({ request: publicReq(req), ...this._route(req, candidates) });
  }

  _route(req, candidates) {
    const result = rankRoutes(candidates, {
      preference: req.preference,
      maxFeeUsd: req.maxFeeUsd,
      maxLatencySec: req.maxLatencySec,
      validitySec: ROUTER.intentTtlSec * 0.8,
    });
    return { ...result, all: candidates };
  }

  // ---------------------------------------------------------------- execution

  /** Create the intent record and execute it asynchronously. */
  submit(body) {
    const req = this.normalise(body);
    const rec = {
      id: randomUUID().slice(0, 8),
      request: publicReq(req),
      status: 'RECEIVED',
      createdAt: Date.now(),
      attempts: [],
      timeline: [],
      result: null,
    };
    this.intents.set(rec.id, rec);
    this._event(rec, 'RECEIVED', `Intent received: ${describe(req)}`);
    rec.done = this._execute(rec, req).catch((err) => {
      this._event(rec, 'FAILED', `Internal error: ${err.message}`);
      rec.status = 'FAILED';
      this._emit(rec);
    });
    return rec;
  }

  async _execute(rec, req) {
    const tried = new Set();
    const maxAttempts = req.noReroute ? 1 : this.rollups.size;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // 1. Route (fresh quote every attempt; skip rollups that already failed this intent).
      rec.status = 'ROUTING';
      const candidates = await this.buildCandidates(req, { skip: tried });
      const routing = this._route(req, candidates);
      let route = routing.best;
      if (attempt === 0 && req.forceRollup) {
        route = candidates.find((c) => c.rollupId === req.forceRollup);
        if (route?.blockers.length) route = null;
      }
      if (attempt === 0) rec.routing = stripBig({ ...routing, decidedAt: Date.now() });
      if (!route) {
        rec.status = 'FAILED';
        const why = routing.explanation.slice(-routing.excluded.length || undefined).join(' ');
        this._event(rec, 'FAILED', `No feasible route. ${why}`);
        return;
      }
      const r = this.rollups.get(route.rollupId);
      tried.add(r.id);
      const att = { rollupId: r.id, startedAt: Date.now(), quote: stripBig(route), status: 'ROUTED' };
      rec.attempts.push(att);
      this._event(
        rec,
        'ROUTED',
        attempt === 0
          ? `Routed to ${r.profile.name}: ${routing.explanation[0]}`
          : `Re-routed to ${r.profile.name} (attempt ${attempt + 1}): ${routing.explanation[0]}`,
        { rollupId: r.id },
      );

      // 2. User signs an intent bound to this rollup (EIP-712 domain = chainId + settlement).
      const intent = this._buildIntent(req, r, route);
      const signer = this.users[req.user];
      const signature = await signer.signTypedData({
        domain: intentDomain(r.profile.chainId, r.deployment.settlement),
        types: INTENT_TYPES,
        primaryType: 'Intent',
        message: intent,
      });
      att.intent = stripBig(intent);
      att.signature = signature;
      att.fee = fromUnits(route.feeUnits, req.token);
      this._event(rec, 'SIGNED', `${cap(req.user)} signed EIP-712 intent for ${r.profile.name} (nonce ${intent.nonce}, deadline +${ROUTER.intentTtlSec}s).`, { rollupId: r.id });

      if (req.simulateOutage && attempt === 0) {
        await r.halt();
        this._event(rec, 'CHAOS', `Simulated sequencer outage: ${r.profile.name} stopped producing blocks.`, { rollupId: r.id });
      }

      // 3. Relay: pre-flight + broadcast.
      let sent;
      try {
        sent = await r.submitFill(intent, signature, route.feeUnits);
      } catch (err) {
        att.status = 'REJECTED';
        att.error = err.shortMessage ?? err.message;
        r.recordOutcome(false);
        this._event(rec, 'RETRY', `Pre-flight failed on ${r.profile.name} (${att.error}). Nothing was broadcast, re-routing immediately.`, { rollupId: r.id });
        continue;
      }
      att.txHash = sent.hash;
      att.submittedAt = Date.now();
      att.status = 'SUBMITTED';
      rec.status = 'SUBMITTED';
      this._event(rec, 'SUBMITTED', `Relayer submitted fill on ${r.profile.name}: ${sent.hash.slice(0, 18)}…`, { rollupId: r.id });

      // 4. Wait for inclusion until the intent's deadline (+ grace). After that the signed
      //    intent can never execute on this rollup (fill reverts with Expired), so a
      //    re-route cannot cause a double execution.
      const deadlineMs = Number(intent.deadline) * 1000 + ROUTER.receiptGraceSec * 1000;
      const receipt = await r.waitReceipt(sent.hash, deadlineMs);
      if (receipt && receipt.status === 'success') {
        this._confirm(rec, att, r, req, receipt, route);
        return;
      }
      r.recordOutcome(false);
      att.status = receipt ? 'REVERTED' : 'TIMEOUT';
      att.error = receipt
        ? 'transaction reverted on-chain'
        : `not included before deadline (${ROUTER.intentTtlSec}s); the signed intent is now expired on ${r.profile.name}`;
      this._event(rec, 'RETRY', `${r.profile.name}: ${att.error}. Safe to re-route.`, { rollupId: r.id });
    }
    rec.status = 'FAILED';
    this._event(rec, 'FAILED', req.noReroute ? 'Execution failed and re-routing is disabled for this intent.' : 'All candidate rollups failed for this intent.');
  }

  _buildIntent(req, r, route) {
    const amountIn = toUnits(req.amount, req.token);
    const maxFee =
      req.maxFeeUsd != null ? usdToUnits(req.maxFeeUsd, req.token) : route.feeUnits * 2n; // default cap: 2x quote
    let minAmountOut = amountIn;
    if (req.kind === 'swap') {
      minAmountOut = (route.amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;
    }
    return {
      kind: KIND[req.kind],
      user: this.users[req.user].address,
      tokenIn: r.tokenAddress(req.token),
      tokenOut: r.tokenAddress(req.tokenOut),
      amountIn,
      minAmountOut,
      recipient: req.recipient,
      maxFee,
      nonce: freshNonce(),
      deadline: BigInt(Math.floor(Date.now() / 1000) + ROUTER.intentTtlSec),
      ref: refHash(req.ref),
    };
  }

  _confirm(rec, att, r, req, receipt, route) {
    const now = Date.now();
    const gasUsed = Number(receipt.gasUsed);
    const l2FeeUsd = (gasUsed * Number(receipt.effectiveGasPrice)) / 1e18 * ETH_USD;
    const l1FeeUsd = route.l1FeeUsd / (1 + ROUTER.relayerMargin);
    let amountOut = null;
    try {
      const [ev] = parseEventLogs({ abi: r.abis.settlement, eventName: 'IntentFilled', logs: receipt.logs });
      if (ev) amountOut = fromUnits(ev.args.amountOut, req.tokenOut);
    } catch {
      // ignore decode issues; receipt status already proves success
    }
    r.recordOutcome(true, { kind: req.kind, gasUsed });
    Object.assign(att, {
      status: 'CONFIRMED',
      confirmedAt: now,
      blockNumber: Number(receipt.blockNumber),
      gasUsed,
      inclusionSec: (now - att.submittedAt) / 1000,
    });
    rec.status = 'CONFIRMED';
    rec.result = {
      rollupId: r.id,
      rollupName: r.profile.name,
      txHash: receipt.transactionHash,
      blockNumber: Number(receipt.blockNumber),
      gasUsed,
      amountOut,
      feeChargedUsd: route.feeUsd,
      actualCostUsd: l2FeeUsd + l1FeeUsd,
      estimatedLatencySec: route.latencySec,
      inclusionSec: att.inclusionSec,
      endToEndSec: (now - rec.createdAt) / 1000,
      attempts: rec.attempts.length,
    };
    this._event(
      rec,
      'CONFIRMED',
      `Confirmed on ${r.profile.name} in block ${receipt.blockNumber} after ${att.inclusionSec.toFixed(1)}s (est. ${route.latencySec.toFixed(1)}s), fee $${route.feeUsd.toFixed(4)}.`,
      { rollupId: r.id },
    );
  }

  _event(rec, type, message, extra = {}) {
    rec.timeline.push({ t: Date.now(), type, message, ...extra });
    this._emit(rec);
  }

  _emit(rec) {
    this.emit('intent', this.view(rec));
  }

  view(rec) {
    const { done, ...rest } = rec;
    return rest;
  }

  list() {
    return [...this.intents.values()].map((r) => this.view(r)).sort((a, b) => b.createdAt - a.createdAt);
  }

  // ---------------------------------------------------------------- reporting

  async balances() {
    const out = {};
    for (const name of NAMED) {
      const addr = this.accounts[name].address;
      out[name] = { address: addr, rollups: {} };
      await Promise.all(
        [...this.rollups.values()].map(async (r) => {
          try {
            const [usdc, weth] = await Promise.all([r.balanceOf('usdc', addr), r.balanceOf('weth', addr)]);
            out[name].rollups[r.id] = { usdc: fromUnits(usdc, 'usdc'), weth: fromUnits(weth, 'weth') };
          } catch {
            out[name].rollups[r.id] = null;
          }
        }),
      );
    }
    return out;
  }

  /**
   * Live statistics. For each confirmed intent we kept the quotes of every rollup at
   * decision time, so we can compare the router with static "always use X" policies.
   */
  stats() {
    const per = Object.fromEntries([...this.rollups.keys()].map((id) => [id, { confirmed: 0, failedAttempts: 0, latency: 0, fee: 0 }]));
    let confirmed = 0, failed = 0, rerouted = 0, sumLat = 0, sumFee = 0;
    const baseline = Object.fromEntries([...this.rollups.keys()].map((id) => [id, { fee: 0, lat: 0, n: 0, infeasible: 0 }]));
    for (const rec of this.intents.values()) {
      for (const a of rec.attempts) if (a.status !== 'CONFIRMED' && a.status !== 'ROUTED' && a.status !== 'SUBMITTED') per[a.rollupId].failedAttempts += 1;
      if (rec.status === 'FAILED') failed += 1;
      if (rec.status !== 'CONFIRMED') continue;
      confirmed += 1;
      if (rec.result.attempts > 1) rerouted += 1;
      const p = per[rec.result.rollupId];
      p.confirmed += 1;
      p.latency += rec.result.inclusionSec;
      p.fee += rec.result.feeChargedUsd;
      sumLat += rec.result.endToEndSec;
      sumFee += rec.result.feeChargedUsd;
      for (const c of rec.routing?.all ?? []) {
        const b = baseline[c.rollupId];
        if (c.blockers?.length || c.health === 'stalled' || c.health === 'unreachable') {
          b.infeasible += 1;
          continue;
        }
        b.n += 1;
        b.fee += c.feeUsd;
        b.lat += c.latencySec;
      }
    }
    for (const p of Object.values(per)) {
      p.avgLatencySec = p.confirmed ? p.latency / p.confirmed : null;
      p.avgFeeUsd = p.confirmed ? p.fee / p.confirmed : null;
      delete p.latency;
      delete p.fee;
    }
    const routerEst = [...this.intents.values()]
      .filter((r) => r.status === 'CONFIRMED')
      .reduce((acc, r) => {
        const chosen = r.routing?.all?.find((c) => c.rollupId === r.result.rollupId) ?? r.attempts.at(-1).quote;
        acc.fee += chosen.feeUsd;
        acc.lat += chosen.latencySec;
        return acc;
      }, { fee: 0, lat: 0 });
    return {
      total: this.intents.size,
      confirmed,
      failed,
      rerouted,
      avgEndToEndSec: confirmed ? sumLat / confirmed : null,
      avgFeeUsd: confirmed ? sumFee / confirmed : null,
      perRollup: per,
      comparison: {
        router: confirmed ? { avgFeeUsd: routerEst.fee / confirmed, avgLatencySec: routerEst.lat / confirmed, infeasible: 0 } : null,
        ...Object.fromEntries(
          Object.entries(baseline).map(([id, b]) => [
            `always ${id}`,
            b.n ? { avgFeeUsd: b.fee / b.n, avgLatencySec: b.lat / b.n, infeasible: b.infeasible } : { infeasible: b.infeasible },
          ]),
        ),
      },
    };
  }
}

// ------------------------------------------------------------------ helpers

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtTok = (units, token) => `${fromUnits(units, token).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${TOKENS[token].symbol}`;

function describe(req) {
  const sym = TOKENS[req.token].symbol;
  if (req.kind === 'swap') return `${cap(req.user)} swaps ${req.amount} ${sym} → ${TOKENS[req.tokenOut].symbol} (${req.preference})`;
  if (req.kind === 'payment') return `${cap(req.user)} pays ${req.amount} ${sym} to ${req.recipientKey} for "${req.ref}" (${req.preference})`;
  return `${cap(req.user)} sends ${req.amount} ${sym} to ${req.recipientKey} (${req.preference})`;
}

function publicReq(req) {
  return { ...req };
}

function stripBig(o) {
  return JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

export { sleep };
