# Test report

Full `npm test` run on 2026-10-22 (macOS, Node 22, Foundry 1.5). Exit code 0.
A fresh copy of the source (clean `npm install` + `forge build` + `npm test`) also passed, run just before `test_SmartWalletCanSignIntent` was added (22 contract tests at that point).

| Suite | Result |
|---|---|
| Contracts (`forge test`) | 23 passed, 0 failed |
| Unit (`node --test test/unit`) | 47 passed, 0 failed |
| End-to-end on 3 Anvil rollups (`node --test test/e2e`) | 10 passed, 0 failed |

## Contract tests
- [x] `testFuzz_SwapNeverDecreasesK(uint256)`
- [x] `testFuzz_TransferConservesValue(uint256,uint256,uint256)`
- [x] `test_OnlyOwnerAdmin()`
- [x] `test_PauseBlocksFills()`
- [x] `test_PaymentEmitsMerchantReference()`
- [x] `test_RemovedRelayerCannotFill()`
- [x] `test_RevertWhen_CallerIsNotRelayer()`
- [x] `test_RevertWhen_Expired()`
- [x] `test_RevertWhen_FeeAboveUserCap()`
- [x] `test_RevertWhen_InsufficientBalance()`
- [x] `test_RevertWhen_InvalidKind()`
- [x] `test_RevertWhen_NoPoolForPair()`
- [x] `test_RevertWhen_RelayerTampersWithIntent()`
- [x] `test_RevertWhen_ReplayingSameIntent()`
- [x] `test_RevertWhen_SignedByWrongKey()`
- [x] `test_RevertWhen_SwapSlippageExceeded()`
- [x] `test_RevertWhen_SwapTooLargeForPoolDepth()`
- [x] `test_RevertWhen_TransferWithMismatchedTokens()`
- [x] `test_RevertWhen_UserCancelledNonce()`
- [x] `test_SignatureIsBoundToOneRollup()`
- [x] `test_SmartWalletCanSignIntent()`
- [x] `test_SwapRoutesThroughPoolAndRespectsQuote()`
- [x] `test_TransferMovesFundsAndPaysRelayer()`

## Node tests (unit suites, then end-to-end)
- [x] L2 fee = gas * (base fee + tip), L1 fee = bytes * DA price
- [x] effective gas price adds the tip to the base fee
- [x] empty sequencer: latency is half a block on average
- [x] backlog adds one block of latency per full block of queued gas
- [x] fee increases monotonically with base fee
- [x] congestion is the max of utilisation and backlog pressure, clamped to 1
- [x] success probability: 95% prior, learns from outcomes, zero when stalled
- [x] valid transfer with defaults
- [x] swap defaults recipient to the user and picks the other token
- [x] rejects unknown user
- [x] rejects negative amount
- [x] rejects NaN amount
- [x] rejects unknown kind
- [x] rejects unknown token
- [x] rejects unknown recipient
- [x] rejects swap same token
- [x] rejects zero max fee
- [x] slippage is clamped to [0, 5000] bps
- [x] type string matches the Solidity INTENT_TYPEHASH
- [x] domain binds chainId and verifying contract (different rollup => different digest)
- [x] ref hash: empty => zero, otherwise keccak of the text
- [x] USD to token units
- [x] nonces are unique
- [x] cheapest policy picks the lowest fee
- [x] fastest policy picks the lowest latency
- [x] balanced policy trades off cost and latency
- [x] unknown preference falls back to balanced
- [x] weights of every policy sum to 1
- [x] maxLatency constraint excludes slow rollups with a reason
- [x] routes expected to outlive the intent validity window are excluded
- [x] maxFee constraint excludes expensive rollups
- [x] stalled / unreachable rollups are never chosen
- [x] blockers from quoting (e.g. insufficient balance) exclude a route
- [x] low success probability excludes a route
- [x] lower success probability is penalised via the risk term
- [x] regression: a slightly better success history must not override a 2x fee gap
- [x] no feasible route returns best = null and explains why
- [x] swaps: worse execution price counts as cost (shortfall)
- [x] scores are deterministic with ties broken by latency then id
- [x] explanation compares the winner with every alternative
- [x] single candidate works
- [x] is deterministic for a given seed
- [x] every submitted intent is accounted for (confirmed or failed)
- [x] light load: every strategy confirms everything
- [x] a single rollup saturates; the router spreads load and keeps confirming
- [x] router avoids a halted rollup
- [x] cheapest policy pays less on average than fastest-leaning static choice
- [x] router digest == on-chain IntentSettlement.hashIntent
- [x] cheapest transfer goes to B, moves exact amounts, pays relayer
- [x] rollup where the user lacks balance is excluded (Alice has 50 USDC on C)
- [x] large swap avoids shallow pools and respects slippage bound
- [x] merchant payment carries the order reference on-chain
- [x] impossible constraints fail cleanly without sending a transaction
- [x] 10 concurrent intents all confirm (relayer nonce management)
- [x] congestion on A pushes "fastest" intents elsewhere
- [x] sequencer outage after signing: safe re-route, no double execution
- [x] quote, submit, stats and validation errors
