# Development log: AI-assisted development evidence

The course allows AI coding agents if the team stays "architect, reviewer, tester and owner".
We split the project into **five modules with one owner each**. Every prompt below was written
by the module owner, every AI output was reviewed, tested or manually exercised by the owner
and one cross-reviewer before being accepted. **The owner of each section answers for it in
Q&A.**

## 1. Module ownership

| Owner | Module | Prompts |
|---|---|---|
| Cheng Chaofan | scaffold, frontend, demo script | §2.1 |
| Zhong Haoyang | smart contracts (`contracts/`, `foundry.toml`, `lib/`) | §2.2 |
| Mo Fan | routing core (`src/core/`, unit tests, `README`) | §2.3 |
| Tian Zhenman | chain infrastructure (`config/`, `src/chain/`, e2e) | §2.4 |
| Jiao Haozhe | service & simulation (`service` / `server` / `simulator`, scripts, results) | §2.5 |

## 2. Prompts by module owner

The agent ran inside the project folder with the two requirement files
(`SC6109 Project Description.md`, `Task.md`) as context. Each table records the prompts one
owner gave for their own module, what the agent produced, and how the owner and one
cross-reviewer checked the result.

### 2.1 Cheng Chaofan — scaffold, frontend & demo script

| # | Prompt (translated from Chinese) | What the agent produced | How we checked it |
|---|---|---|---|
| C1 | "Scaffold the Node project: Express, no frontend build step (vanilla JS + Chart.js served from `public/`), `.gitignore` for node modules / foundry out / cache. Everything must run offline from a fresh clone." | `package.json`, `package-lock.json`, `.gitignore` | Fresh-copy `npm install` + `npm run demo` |
| C2 | "Build the UI shell: three rollup cards (block number, block time, gas price, est. fee & latency, congestion bar, success probability), a route comparison table with score breakdown, an execution stepper, tabs for balances / live analytics / simulation." | `public/index.html`, `public/style.css` | Walked every tab against live data |
| C3 | "Switch the background to a light colour scheme; charts must stay readable." | Light palette for UI and charts | Visual check in the browser |
| C4 | "Frontend logic: a natural-language parser for intents like *send 100 USDC to Bob as cheap as possible*, compare-routes and sign-and-execute flows driven by the SSE stream, Chart.js visualisations for analytics and simulation." | `public/app.js`; pointerdown fix for bug 9 after browser testing | Manually exercised every UI scenario in the demo guide |
| C5 | "One-command demo: build the contracts, boot the three rollups, deploy and fund everything, then serve the UI from one terminal." | `scripts/demo.js` | Killed and re-ran from clean state repeatedly |
| C6 | "I need to record the demo video. How do I do it step by step?" | The demo recording guide (step-by-step walkthrough + narration script); every routing outcome re-verified against the running system, and a wrong step in the README script fixed | Full rehearsal run, then re-verified after a restart |
| C7 | "Start `docs/DEV_LOG.md`: record our prompts per module, decisions, and bugs." | This file | Cross-read by all five owners |

### 2.2 Zhong Haoyang — smart contracts

| # | Prompt (translated from Chinese) | What the agent produced | How we checked it |
|---|---|---|---|
| Z1 | "Set up the Foundry project: solc, optimizer on, 256 fuzz runs; vendor forge-std and OpenZeppelin Contracts v5 under `lib/`." | `foundry.toml`, vendored `lib/forge-std` + `lib/openzeppelin-contracts` | `forge build` clean |
| Z2 | "Write MockERC20 (owner-mintable) and MiniAMM: constant product, 0.30 % fee, `getAmountOut` quoting, `minAmountOut` slippage revert. Keep the pools deliberately shallow and different per rollup so price impact is observable." | `MockERC20.sol`, `MiniAMM.sol` | k-invariant fuzz test (Z5); swap routing shows real price impact in the demo |
| Z3 | "Write `IntentSettlement.sol`: EIP-712 domain bound to chainId **and** the contract address; unordered nonces with a used-bitmap plus `cancelNonce`; deadline enforced in `fill`; relayer allow-list; fee capped by `maxFee`; Ownable2Step, Pausable, ReentrancyGuard, SignatureChecker so ERC-1271 smart wallets can sign. Burn the nonce **before** any token transfer." | `IntentSettlement.sol` | Line-by-line review against the OpenZeppelin docs; 23-test suite below |
| Z4 | "`forge build` fails with *Stack too deep* in IntentSettlement — fix it without changing behaviour." | `abi.encode(TYPEHASH, intent)` (static struct ≡ field concatenation) and a slimmer event — bug 1 | Build passes; all tests still green |
| Z5 | "23 Foundry tests: replay, forged/tampered signature, non-relayer, fee cap, expiry, cancelled nonce, insufficient balance with nonce rollback, slippage, pool depth, kind validation, cross-rollup signature isolation, access control, pause, ERC-1271 smart-wallet signer, value conservation, AMM k-invariant fuzz." | `contracts/test/IntentSettlement.t.sol` | `forge test` — 23 passed incl. 2 fuzz × 256 runs; cross-reviewed by Mo Fan against the threat list |
| Z6 | "Write `docs/DESIGN.md` — architecture, routing-score derivation, trust trade-offs, limitations — plus an architecture diagram." | `docs/DESIGN.md`, `docs/architecture.svg` | Team review: every claim traced to code or a test |
| Z7 | "Switch the architecture diagram to a light theme as well, matching the UI." | Recoloured `docs/architecture.svg` | Visual check next to the UI |

### 2.3 Mo Fan — routing core

| # | Prompt (translated from Chinese) | What the agent produced | How we checked it |
|---|---|---|---|
| M1 | "Implement `src/core/intent.js`: the EIP-712 Intent typed data in JS — type string **byte-identical** to the contract's, per-rollup domain (chainId + verifyingContract), request validation, digest. The per-rollup domain is what makes a signature unusable on a second rollup; keep that property explicit." | `src/core/intent.js` | Digest parity asserted on-chain by the e2e suite (T5) |
| M2 | "Implement `src/core/feeModel.js`: L2 execution fee from the live base fee + sequencer tip with an EWMA of real `gasUsed`; DA fee modelled from the real 548-byte calldata size × per-rollup price/byte (A calldata, B batches, C alt-DA); latency = blockTime × (0.5 + queued gas / block gas limit) from live `txpool_content`; success probability = Beta(19,1) prior updated with our outcomes × health factor." | `src/core/feeModel.js` | Fee edges unit-tested; estimates compared with actual receipts in the demo |
| M3 | "Implement `src/core/router.js`: **hard constraints first** — stalled sequencer, balance/allowance, swap price impact > 2 %, user max fee, user max latency, intent validity window, p(success) < 50 % — each producing a human-readable exclusion reason; then the weighted score `w_cost·cost + w_lat·latency + w_risk·(1−p)/0.5` with cheapest/balanced/fastest policies; deterministic tie-breaks; an explanation comparing the winner with every alternative." | `src/core/router.js` | Policy/constraint unit tests (M6); explanation strings shown verbatim in the UI |
| M4 | "Manual UI test with congestion: the router sent an intent to a rollup with 26 s expected latency. Only the *user's* latency cap was checked — the 15 s intent deadline was not. Add a validity-window hard constraint (80 % of TTL) and a regression test." | `validitySec` constraint, used by router and simulator — bug 6 | Regression unit test; validity-window exclusion shown in demo step 6 |
| M5 | "Live benchmark: all 40 'cheapest' intents went to C at 2.3× A's cost. The risk term normalised by the worst candidate turns 5 % vs 1.7 % failure into a 1.0 vs 0.33 score gap, so a rollup's own success history outweighed fees (rich-get-richer). Switch to an absolute `(1 − p) / 0.5` scale and add a regression test." | Absolute risk scale — bug 7 | Regression unit test; benchmark re-run (J6) shows cheapest policy recovering |
| M6 | "Unit tests: intent validation, EIP-712 type string, digest parity with the contract TYPEHASH, fee-model edges; then routing policies, constraint exclusions, simulator invariants." | `test/unit/*.test.js` (4 files, 47 tests) | `node --test test/unit` — 47 passed |
| M7 | "Write the README: quickstart, requirement checklist, test matrix, results tables, demo script, API reference." | `README.md` | Every command copy-pasted in a fresh clone |

### 2.4 Tian Zhenman — chain infrastructure

| # | Prompt (translated from Chinese) | What the agent produced | How we checked it |
|---|---|---|---|
| T1 | "Write `config/rollups.js` with three profiles: A optimistic — 1 s blocks, 1.2M gas, expensive DA; B zk-style — 4 s blocks, 4.0M gas, cheap batched DA; C appchain — 2 s blocks, 0.9M gas, alt-DA committee. Include demo accounts, initial balances and router constants." | `config/rollups.js` | Congestion/latency differences *emerge* from these numbers — verified in demo step 6 |
| T2 | "Implement `src/chain/devnet.js` + `artifacts.js`: boot three anvil instances (FIFO ordering, per-chain gas limits), deploy the contracts on each, fund users, set allowances. Contract creation needs more gas than the small block limits allow — start anvil at 30M, deploy, then `evm_setBlockGasLimit` down to each rollup's capacity." | `src/chain/devnet.js`, `src/chain/artifacts.js`; the gas workaround is bug 2, found on the first demo run | Every fresh `npm run demo` boots to a funded, deterministic state |
| T3 | "Implement `src/chain/rollup.js`: a monitor polling blocks and `txpool_content` every 0.4–0.7 s; health detection (stalled when the latest block is older than max(3 × block time, 4 s)); a relayer with a serial per-chain nonce queue that resyncs from chain on error; chaos controls congest / halt / resume." | `src/chain/rollup.js` | 10-concurrent-intents e2e test exercises the nonce queue; halt/resume drive demo step 7 |
| T4 | "Add `scripts/chains.js` to run the three rollups standalone for debugging." | `scripts/chains.js` | Used it to debug the incident scenario with Jiao |
| T5 | "The e2e suite was flaky right after 10 concurrent intents — the monitor snapshot (polled every 0.4–0.7 s) still showed those txs pending. Wait for fresh metrics in the test, and note the staleness as a limitation." | Fresh-metrics wait in the test — bug 8; limitation documented in DESIGN §10 | 20 consecutive e2e runs green |
| T6 | "Write the e2e suite on three fresh chains: EIP-712 digest parity with the contract's `hashIntent`, exact balance deltas, exclusion reasons, large-swap routing and slippage, merchant ref, no-route failure without broadcasting a tx, 10 concurrent intents, congestion adaptivity, and outage → safe re-route → stale fill reverts on-chain." | `test/e2e/router.e2e.test.js` | `node --test test/e2e` — 10 passed on ports 18545+ so it never fights the demo |
| T7 | "Collect the full-suite results into `results/test-report.md`." | `results/test-report.md` | Re-ran everything fresh before recording |

### 2.5 Jiao Haozhe — service & simulation

| # | Prompt (translated from Chinese) | What the agent produced | How we checked it |
|---|---|---|---|
| J1 | "Implement `src/service.js`: quote → route → sign → relay → confirm, attempts recorded per rollup. Re-route **immediately** on a pre-flight revert (nothing was broadcast), but for a broadcast tx wait until the intent deadline + 3 s — the chain-bound signature plus the on-chain expiry means a stale fill cannot confirm twice." | `src/service.js` | Outage e2e: exactly one confirmation on-chain (T6); demo step 7 |
| J2 | "Routing responses crashed JSON serialisation — bigint fee fields. Strip bigints at the API boundary, keep them internally for execution." | API-boundary bigint serialisation — bug 3 (found by Cheng at the UI) | First API call + all UI flows |
| J3 | "Implement `src/server.js`: REST endpoints `/api/rollups` `/api/quote` `/api/intents` `/api/stats` `/api/balances` `/api/sim` plus the chaos controls, an SSE stream pushing rollup metrics every second, static UI serving." | `src/server.js` | Every endpoint exercised by the e2e suite and the UI |
| J4 | "Implement `src/sim/simulator.js` **reusing the production core modules**: FIFO sequencers, per-chain gas limits, EIP-1559 base fee, background traffic, the 15 s validity window, deadline re-routing. Simulated users need a `maxFeePerGas` and an absolute willingness-to-pay cap, or the base fee grows without bound." | `src/sim/simulator.js`; the exploding-fee fix is bug 4 | 60 s runs hold all invariants (M6's simulator tests) |
| J5 | "The incident replay showed 'always B' as perfect — the scenario disrupted A and C only, so it didn't test the router's value. Congest B (the cheap default everyone would pick) and halt C." | Incident scenario redesign — bug 5 | Re-run: pinned-to-C loses 78 %, router stays ~0 % — the honest comparison |
| J6 | "Add `scripts/sim.js` writing `results/sim-results.{json,md}`, and `scripts/bench-live.js` benchmarking router vs always-A/B/C on the real chains at 20 intents/s, writing `results/live-bench.{json,md}`." | `scripts/sim.js`, `scripts/bench-live.js` | `npm run sim`, `npm run bench:live` from clean state |
| J7 | "Record the outputs and confirm the numbers reproduce." | Recorded `results/sim-results.{json,md}` and `results/live-bench.{json,md}` | 3 consecutive runs reproduce within noise |

## 3. Cross-module collaboration

These are the points where two or more owners had to agree before prompting the agent —
the interfaces the five modules actually meet at:

| Interface | Who agreed | Where it shows up |
|---|---|---|
| EIP-712 digest parity | Zhong exposed `hashIntent()` on-chain ↔ Mo's JS digest ↔ Tian's e2e asserts byte equality | `test/e2e` digest-parity test; DESIGN §3 |
| Monitor snapshot format | Tian's `rollup.js` snapshot ↔ Mo's `feeModel.js` consumer. Joint decision: latency counts queued gas by each pending tx's **gas limit** (conservative overestimate) | DESIGN §5; §6 "changed" list |
| One routing core everywhere | Mo kept `core/` pure (no I/O) so Jiao's simulator imports the same modules | `npm run sim` numbers describe the same algorithm the demo runs |
| SSE payload ↔ UI | Jiao's event fields ↔ Cheng's rendering; bigint crash (bug 3) found by Cheng at the UI, fixed by Jiao at the API boundary | `public/app.js`, `src/server.js` |
| Demo chain | Cheng's `scripts/demo.js` drives Tian's devnet; a wrong README step found in Cheng's rehearsal (C6) was fixed jointly | `npm run demo`, README quick start |
| Review rule | All five | Every AI-generated change was accepted by its module owner **only after one other member cross-reviewed it** (the "how we checked it" columns above) |

## 4. Decisions made up front

| Decision | Alternatives considered | Why | Owner |
|---|---|---|---|
| 3 real local chains (Anvil) instead of a pure simulation | Fully simulated rollups | Real signatures, real reverts, real nonces and a real txpool. The router's safety claims are tested against an actual EVM. | whole team |
| Different block time / gas limit / ordering per chain | Identical chains with fake numbers | Congestion and latency then *emerge* from the chain (FIFO queue, gas limit, EIP-1559) instead of being hard-coded | Tian Zhenman |
| Sign *after* routing, signature bound to one rollup | One chain-agnostic signature valid everywhere | A chain-agnostic signature can be executed on two rollups (double spend). Re-routing safety comes from chain-bound signatures + deadline. | Zhong Haoyang (contract) + Mo Fan (JS domain) |
| Relayer allow-list | Permissionless solvers | Smaller scope. Documented as a centralisation trade-off. | Zhong Haoyang |
| Pure `core/` modules shared by live router and simulator | Separate simulator logic | The scalability numbers then describe the *same* algorithm the demo runs | Mo Fan (proposed) + Jiao Haozhe (consumes) |
| Vanilla JS frontend + Chart.js served locally | React + build step | No build step and no CDN dependency during the recorded demo | Cheng Chaofan |

## 5. Bugs found and fixed

| # | Symptom | Root cause | Fix | Caught by | Owner |
|---|---|---|---|---|---|
| 1 | `forge build`: *Stack too deep* in `IntentSettlement` | 11-field event + `abi.encode` of 12 values | `abi.encode(TYPEHASH, intent)` (static struct ≡ field concatenation) and a slimmer event | compiler | Zhong Haoyang |
| 2 | Deploy reverted: *gas required exceeds allowance 1200000* | Small block gas limits (for congestion realism) are below contract-creation gas | Start Anvil at 30M gas, deploy, then `evm_setBlockGasLimit` to the rollup's capacity | first demo run | Tian Zhenman |
| 3 | Routing results crashed JSON serialisation | `bigint` fields (fee units, AMM output) in API responses | Strip bigints at the API boundary, keep them internally for execution | first API call | Jiao Haozhe |
| 4 | Simulated fees exploded to $50/intent | Simulated demand ignored price, so the EIP-1559 base fee grew without bound | Every simulated tx has a `maxFeePerGas`; users have absolute willingness-to-pay caps | reviewing the fee chart | Jiao Haozhe |
| 5 | Incident experiment showed "always B" as perfect | Scenario disrupted A and C only, so it didn't test the router's value | Congest B (the cheapest, most popular default) and halt C | reviewing results | Jiao Haozhe |
| 6 | Router would send intents to a rollup with 26 s expected latency | Only the *user's* max latency was checked; the 15 s intent deadline was not | New hard constraint `validitySec` (80 % of TTL), also used by the simulator | manual UI test with congestion | Mo Fan |
| 7 | "cheapest" policy picked a rollup 2.3× more expensive | Risk term normalised by the worst candidate: 5 % vs 1.7 % failure became a 1.0 vs 0.33 score gap. A rollup's own success history outweighed fees (rich-get-richer loop). | Absolute risk scale `(1 − p) / 0.5` + regression unit test | live benchmark (all 40 "cheapest" intents went to C) | Mo Fan |
| 8 | E2E test flaky: A looked congested right after 10 concurrent intents | Monitor snapshot (polled every 0.4–0.7 s) still showed those txs pending | Test waits for fresh metrics; staleness documented as a limitation | E2E test | Tian Zhenman |
| 9 | Clicking card buttons sometimes did nothing | Cards re-render every second, which can swallow a click between mousedown and mouseup | Handle `pointerdown` | browser testing | Cheng Chaofan |

## 6. AI suggestions we changed or rejected

- **Rejected** (Mo Fan, with Zhong Haoyang): letting the router re-route immediately after a
  timeout. The stuck tx could still be mined later, which means double execution. We wait for
  the on-chain deadline instead.
- **Rejected** (Tian Zhenman): spam transactions bidding a low gas price. They could become
  non-includable when the base fee rose, sit in the pool forever and fake a permanent backlog.
  Spam uses a generous `maxFeePerGas`.
- **Changed** (Mo Fan + Tian Zhenman, joint review): the latency estimate counts queued gas
  using each pending tx's *gas limit* (from `txpool_content`). That is conservative; it
  overestimates slightly versus gas used.
- **Changed** (Mo Fan): swap cost includes the output shortfall versus the best pool, not just
  the fee. Otherwise the cheapest-fee rollup with a shallow pool wins large swaps and the user
  loses more to price impact than they save on fees.

## 7. Verification summary

- `forge test`: 23 contract tests (incl. 2 fuzz tests × 256 runs): replay, wrong signer,
  tampering, non-relayer, fee cap, expiry, cancelled nonce, insufficient balance (nonce rolled
  back), slippage, pool depth, missing pool, kind validation, cross-rollup signature
  isolation, admin access control, pause, ERC-1271 smart-wallet signer (account abstraction), value
  conservation, AMM `k` invariant.
- `node --test test/unit`: 47 tests for routing policies, constraints, explanations, fee
  model, request validation, EIP-712 type string, simulator invariants.
- `node --test test/e2e`: 10 tests on 3 fresh Anvil chains. They cover EIP-712 digest parity with
  the contract, balances moved exactly, exclusion reasons, large swap routing and slippage,
  merchant reference, no-route failure without a tx, 10 concurrent intents, congestion
  adaptivity, and outage re-routing with on-chain proof of no double execution.
