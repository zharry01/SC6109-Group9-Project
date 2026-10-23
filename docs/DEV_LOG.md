# Development log: AI-assisted development evidence

The course allows AI coding agents if the team stays "architect, reviewer, tester and owner".
This log records the prompts given to the AI agent, the key design decisions, the AI
suggestions we accepted, changed or rejected, and the bugs found during testing. **Team: add your own prompts and review notes
below. Expect to be asked about them in Q&A.**

## Prompts given to the AI coding agent (Claude Code)

The agent was used inside the project folder with the two requirement files
(`SC6019 Project Description.md`, `Task.md`) as context. Main prompts, in order:

| # | Prompt (translated from Chinese) | What the agent produced | How we checked it |
|---|---|---|---|
| 1 | "Based on the two requirement files, which topic is easiest to demo in a video, with simple operation?" | Comparison of the 6 options; recommended Option 6 (simulated rollups allowed, frontend required, visual demo) | Read the requirement text ourselves; chose Option 6 |
| 2 | "Choose Option 6. Following the project requirements, complete all the code in a subfolder and test it." | Architecture (3 Anvil rollups, settlement contract, router, UI), contracts, router, tests, simulator, docs | Reviewed the design table below; ran all test suites; manually exercised every UI scenario; found bugs 6–9 below through our own testing and benchmarking |
| 3 | "Change the background to a light colour scheme." | Light palette for UI and charts | Visual check in the browser |
| 4 | "Switch the architecture diagram to a light theme as well, matching the UI." | Recoloured `docs/architecture.svg` | Visual check |
| 5 | "I need to record the demo video. How do I do it step by step?" | `docs/DEMO_RECORDING_GUIDE.md`; every routing outcome re-verified against the running system, and a wrong step in the README script fixed | Rehearsal run |
| 6 | "Check again that the project meets the requirements, then make the presentation slides (matching the frontend style, ~3 min) and a speech script." | Requirement audit → added the ERC-1271 smart-wallet test, this prompt log and a test report; slides + script in `pre/` | Fresh-copy install + full test run |

> **Team:** add any further prompts you used (e.g. for slides or Q&A preparation) and your own review notes.

## Decisions made up front

| Decision | Alternatives considered | Why |
|---|---|---|
| 3 real local chains (Anvil) instead of a pure simulation | Fully simulated rollups | Real signatures, real reverts, real nonces and a real txpool. The router's safety claims are tested against an actual EVM. |
| Different block time / gas limit / ordering per chain | Identical chains with fake numbers | Congestion and latency then *emerge* from the chain (FIFO queue, gas limit, EIP-1559) instead of being hard-coded |
| Sign *after* routing, signature bound to one rollup | One chain-agnostic signature valid everywhere | A chain-agnostic signature can be executed on two rollups (double spend). Re-routing safety comes from chain-bound signatures + deadline. |
| Relayer allow-list | Permissionless solvers | Smaller scope. Documented as a centralisation trade-off. |
| Pure `core/` modules shared by live router and simulator | Separate simulator logic | The scalability numbers then describe the *same* algorithm the demo runs |
| Vanilla JS frontend + Chart.js served locally | React + build step | No build step and no CDN dependency during the recorded demo |

## Bugs found and fixed

| # | Symptom | Root cause | Fix | Caught by |
|---|---|---|---|---|
| 1 | `forge build`: *Stack too deep* in `IntentSettlement` | 11-field event + `abi.encode` of 12 values | `abi.encode(TYPEHASH, intent)` (static struct ≡ field concatenation) and a slimmer event | compiler |
| 2 | Deploy reverted: *gas required exceeds allowance 1200000* | Small block gas limits (for congestion realism) are below contract-creation gas | Start Anvil at 30M gas, deploy, then `evm_setBlockGasLimit` to the rollup's capacity | first demo run |
| 3 | Routing results crashed JSON serialisation | `bigint` fields (fee units, AMM output) in API responses | Strip bigints at the API boundary, keep them internally for execution | first API call |
| 4 | Simulated fees exploded to $50/intent | Simulated demand ignored price, so the EIP-1559 base fee grew without bound | Every simulated tx has a `maxFeePerGas`; users have absolute willingness-to-pay caps | reviewing the fee chart |
| 5 | Incident experiment showed "always B" as perfect | Scenario disrupted A and C only, so it didn't test the router's value | Congest B (the cheapest, most popular default) and halt C | reviewing results |
| 6 | Router would send intents to a rollup with 26 s expected latency | Only the *user's* max latency was checked; the 15 s intent deadline was not | New hard constraint `validitySec` (80 % of TTL), also used by the simulator | manual UI test with congestion |
| 7 | "cheapest" policy picked a rollup 2.3× more expensive | Risk term normalised by the worst candidate: 5 % vs 1.7 % failure became a 1.0 vs 0.33 score gap. A rollup's own success history outweighed fees (rich-get-richer loop). | Absolute risk scale `(1 − p) / 0.5` + regression unit test | live benchmark (all 40 "cheapest" intents went to C) |
| 8 | E2E test flaky: A looked congested right after 10 concurrent intents | Monitor snapshot (polled every 0.4–0.7 s) still showed those txs pending | Test waits for fresh metrics; staleness documented as a limitation | E2E test |
| 9 | Clicking card buttons sometimes did nothing | Cards re-render every second, which can swallow a click between mousedown and mouseup | Handle `pointerdown` | browser testing |

## AI suggestions we changed or rejected

- **Rejected:** letting the router re-route immediately after a timeout. The stuck tx could
  still be mined later, which means double execution. We wait for the on-chain deadline instead.
- **Rejected:** spam transactions bidding a low gas price. They could become non-includable when
  the base fee rose, sit in the pool forever and fake a permanent backlog. Spam uses a generous
  `maxFeePerGas`.
- **Changed:** the latency estimate counts queued gas using each pending tx's *gas limit* (from
  `txpool_content`). That is conservative; it overestimates slightly versus gas used.
- **Changed:** swap cost includes the output shortfall versus the best pool, not just the fee.
  Otherwise the cheapest-fee rollup with a shallow pool wins large swaps and the user loses
  more to price impact than they save on fees.

## Verification summary

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
