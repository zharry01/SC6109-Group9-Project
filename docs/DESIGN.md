# Design: Cross-Rollup Intent Router

## 1. Problem

A modular Ethereum has many rollups with very different cost, speed, capacity and trust
profiles. Asking every user to pick a chain (and to keep re-picking as congestion moves around)
does not scale for people and wastes capacity: users pile onto the chain they know while
others sit idle. The router lets a user state an **outcome** ("pay the coffee shop 4.50 USDC",
"swap 300 USDC to WETH", "as cheap as possible, within 10 s") and decides **where** it
executes based on live fee, latency, congestion and reliability.

## 2. Architecture

```
 ┌────────────── Browser (public/) ──────────────┐
 │ intent form · NL parser · route table ·        │
 │ execution timeline · analytics · sim charts   │
 └───────────────▲──────────────┬────────────────┘
        SSE (1 s)│              │REST (quote / submit / chaos)
 ┌───────────────┴──────────────▼────────────────────────────────┐
 │ Node router service (src/)                                     │
 │  core/router.js     pure scoring + constraints + explanation   │
 │  core/feeModel.js   L2 exec fee + DA fee, latency, p(success)  │
 │  core/intent.js     EIP-712 Intent type, validation            │
 │  service.js         quote → route → sign → relay → confirm,    │
 │                     safe re-routing, stats                     │
 │  chain/rollup.js    monitor (blocks, txpool), reads, relayer   │
 │                     nonce queue, chaos controls                │
 └──────┬─────────────────────┬─────────────────────┬────────────┘
        │ JSON-RPC            │                     │
 ┌──────▼──────┐       ┌──────▼──────┐       ┌──────▼──────┐
 │ Rollup A    │       │ Rollup B    │       │ Rollup C    │   one Anvil each
 │ 1 s blocks  │       │ 4 s blocks  │       │ 2 s blocks  │   FIFO sequencer,
 │ 1.2M gas    │       │ 4.0M gas    │       │ 0.9M gas    │   EIP-1559 base fee
 │ DA 30 gw/B  │       │ DA 5 gw/B   │       │ DA 12 gw/B  │
 │ Settlement  │       │ Settlement  │       │ Settlement  │   same contracts
 │ USDC WETH   │       │ USDC WETH   │       │ USDC WETH   │   on every rollup
 │ MiniAMM     │       │ MiniAMM     │       │ MiniAMM     │   (different depth)
 └─────────────┘       └─────────────┘       └─────────────┘
```

| Concern | Where it lives | Why there |
|---|---|---|
| Moving user funds, replay protection, expiry, fee cap, slippage | `IntentSettlement.sol` (on-chain) | Must hold even if the router or relayer is malicious |
| Route selection | `core/router.js` (off-chain) | Needs live cross-chain data; no chain can see the others |
| Fee / latency estimation | `core/feeModel.js` (off-chain) | Shared by live router and simulator |
| Relaying, nonce management, retries | `service.js`, `chain/rollup.js` | Operational, latency-sensitive |
| UI | `public/` | Demonstration and explanation |

## 3. Intent format

EIP-712 typed data, domain `{name: "CrossRollupIntentSettlement", version: "1", chainId, verifyingContract}`:

```
Intent(uint8 kind, address user, address tokenIn, address tokenOut, uint256 amountIn,
       uint256 minAmountOut, address recipient, uint256 maxFee, uint256 nonce,
       uint256 deadline, bytes32 ref)
```

- `kind`: 0 transfer, 1 merchant payment (with `ref` = keccak of the order id), 2 swap.
- `maxFee`: the most the relayer may charge, in `tokenIn` units (user protection).
- `minAmountOut`: slippage bound for swaps (quote × (1 − slippage)).
- `nonce`: unordered (time-based), so many intents can be in flight; user can `cancelNonce`.
- `deadline`: 15 s after signing. This is the key to safe re-routing (section 6).

The domain contains the chain id **and** the settlement address, so a signature is valid on
exactly one rollup. The router therefore asks the user to sign *after* choosing the route.

## 4. Routing algorithm (`src/core/router.js`)

For every rollup the service builds a candidate with: live health, relayer fee in USD,
expected latency, success probability, and (for swaps) the AMM quote. Then:

1. **Hard constraints** exclude a candidate (with a human-readable reason):
   stalled/unreachable sequencer; insufficient balance or allowance; swap price impact > 2 %;
   fee > user's max fee; latency > user's max latency; expected latency longer than the
   intent validity window (12 s = 80 % of the deadline); success probability < 50 %.
2. **Weighted score** (lower is better) over the remaining candidates:

   `score = w_cost · cost/maxCost + w_lat · latency/maxLatency + w_risk · (1 − p)/0.5`

   | policy | w_cost | w_lat | w_risk |
   |---|---|---|---|
   | cheapest | 0.70 | 0.20 | 0.10 |
   | balanced | 0.45 | 0.40 | 0.15 |
   | fastest | 0.20 | 0.70 | 0.10 |

   For swaps, `cost = fee + shortfall`, where shortfall is the USD value of output lost
   versus the best pool. That is why a large swap avoids a cheap rollup with a shallow pool.
3. **Explanation**: the winner is compared to every alternative ("83 % cheaper, 1.5 s
   slower") and every exclusion reason is listed. The UI shows this verbatim.

Ties break on latency, then rollup id, so routing is deterministic and unit-testable.

## 5. Fee, latency and reliability model (`src/core/feeModel.js`)

- **L2 execution fee** = `gas × (base fee + sequencer tip)`. The base fee is read live
  from the latest block (Anvil implements EIP-1559). `gas` starts from a per-kind default and
  is updated with an EWMA of real `gasUsed`.
- **L1 data-availability fee** = `calldata bytes × DA price per byte`. Anvil has no L1, so
  this is the one modelled component. The per-byte prices stand in for Ethereum calldata (A),
  compressed batches/blobs (B) and an alt-DA committee (C). The calldata size is the
  real ABI-encoded size of `fill` (548 bytes).
- **Latency** = `blockTime × (0.5 + ⌊queued gas / block gas limit⌋)`. The queued gas comes
  from the live `txpool_content`. Anvil runs with `--order fifo` (a first-come-first-served
  sequencer), so queued transactions really do delay ours.
- **Success probability** = Beta(19, 1) prior (95 %), updated with the router's own outcomes
  on that rollup, × a health factor (healthy 1, degraded 0.6, stalled/unreachable 0).
  A rollup is *stalled* when its latest block is older than max(3 × block time, 4 s).

Relayer fee charged to the user = estimated cost × 1.10 (10 % relayer margin), converted to the
input token at a fixed oracle price (ETH = $3000).

## 6. Execution and safe re-routing

```
RECEIVED → ROUTED → SIGNED → SUBMITTED → CONFIRMED
                 ↑                    │ pre-flight revert ──→ re-route now (nothing broadcast)
                 └──── re-route ──────┤ reverted on-chain ──→ re-route
                                      └ no receipt by deadline + 3 s → re-route
```

The danger in cross-rollup re-routing is **double execution**. A transaction stuck on a
halted rollup could still be mined later, after we have already paid on another rollup.
The design prevents this without any cross-chain messaging:

1. The signature for rollup X is only valid on X (EIP-712 domain).
2. The router waits until the intent's `deadline` (+3 s grace) has passed before re-routing.
3. After that, any late inclusion on X reverts with `Expired`, because the contract checks
   `block.timestamp <= deadline`.

The end-to-end test `sequencer outage after signing` demonstrates this. It halts C, waits for
the timeout, re-routes to another rollup, resumes C, and asserts the stale fill reverted and the
recipient was paid once. The cost of this safety is latency: a failed attempt costs up to 18 s.
Pre-flight failures (`eth_estimateGas` reverts) re-route immediately because nothing was broadcast.

Each rollup's relayer submissions run through a serial queue with local nonce tracking, and
resync from chain on error. The E2E test sends 10 concurrent intents to check this.

## 7. Smart contracts

- `IntentSettlement` (OpenZeppelin `EIP712`, `Ownable2Step`, `Pausable`, `ReentrancyGuard`,
  `SignatureChecker`, so ERC-1271 smart accounts can sign intents too; covered by
  `test_SmartWalletCanSignIntent`).
  - `fill(intent, signature, fee)`: `onlyRelayer`, `whenNotPaused`, `nonReentrant`. It checks
    kind, deadline, fee ≤ maxFee, non-zero fields, nonce unused and the signature, then burns
    the nonce **before** any token transfer (checks-effects-interactions).
    Swaps pull `tokenIn`, `forceApprove` the pool and swap with `minAmountOut`.
  - `cancelNonce`, `setRelayer`, `setPool`, `pause/unpause`, `hashIntent` (lets the off-chain
    encoding be cross-checked; the E2E test asserts equality).
- `MiniAMM`: constant product with a 0.30 % fee, `getAmountOut` for quoting, and slippage
  revert. Liquidity is owner-managed (out of scope: LP shares).
- `MockERC20`: owner-mintable test token.

Users approve the settlement contract once per token per rollup at setup. In production this
would be Permit2 or ERC-4337 session keys, so no per-chain approval UX is needed.

## 8. Trust assumptions and centralisation risks

| Component | Trusted for | Not trusted for |
|---|---|---|
| Router | Liveness and route *quality* (it could route badly or censor) | Funds: it cannot move funds beyond what the user signed |
| Relayer | Liveness, paying gas | Fee above `maxFee`, changing recipient/amount (signature) |
| Settlement owner | Relayer allow-list, pool registry, pause | Taking user funds (no such function) |
| Rollup sequencer | Ordering and inclusion (FIFO here) | Validity (settles to L1) |
| DA layer (C) | Data availability via committee, which is an *extra* assumption vs A/B | — |
| Price oracle | USD conversion for fee display/caps | — |

**Risks the design introduces.** One router sees all order flow. That is an MEV and
censorship point, and its routing policy becomes a de-facto standard. The relayer
allow-list is centralised.

**Mitigations.** Open the `fill` role to any solver with a bond (like CoW/Across solvers). Let
several routers compete on quotes (RFQ). Publish the routing policy (the explanation is
already user-visible). Users can always fill their own intent on any rollup directly.

## 9. Why this improves scalability

- **Aggregate capacity.** Without routing, users concentrate on a familiar rollup, and the
  system's effective throughput is that rollup's capacity. With routing it approaches the
  *sum* of all rollups' spare capacity. In the simulation the best single rollup saturates
  near 5–6 intents/s, while the router keeps 0 % failures up to 14 intents/s and confirms
  ~3× more at 20 intents/s.
- **Load balancing via price signals.** The router reads EIP-1559 base fees and sequencer
  backlogs, so new demand flows away from congested chains. That keeps their fees from
  spiralling and keeps latency bounded.
- **Fault isolation.** A sequencer outage stops being a user-visible outage. Health
  detection plus deadline-based re-routing moves traffic away (incident replay: 0–0.2 %
  failures for the router vs 78 % for users pinned to the halted rollup).
- **User scalability.** Users no longer need to understand N chains. The cognitive and UX
  cost stays constant as the number of rollups grows.

**Trilemma.** Routing improves scalability without changing any rollup's security. It adds an
off-chain coordination layer (some decentralisation cost) and lets users knowingly trade
security for cost (e.g. C's alt-DA). The UI makes this explicit with each rollup's
settlement/DA assumption.

## 10. Limitations

- Rollups are local Anvil chains. L1 settlement, proofs and the DA fee are modelled, not real.
- Liquidity is fragmented per rollup. Moving a user's funds between rollups (bridging) is
  out of scope; the router only uses balances already on each rollup.
- Monitor data can be up to one poll interval (0.7 s) stale. Right after a burst, a rollup can
  look busier than it is (we hit this in the E2E tests).
- Demo users' keys are held by the backend to sign intents. This is a demo shortcut; a real
  deployment signs in the user's wallet (EIP-712 `eth_signTypedData_v4`).
- The success-probability prior and policy weights are hand-tuned, not learned.
