# Individual Contribution Report

Our team of five contributed **equally** to this project. Each member owned one module end-to-end — design, implementation, testing and documentation. Beyond their own modules, all members took part in requirement analysis, cross-module interface agreements.

| Member | Module | Contribution summary |
|---|---|---|
| Cheng Chaofan | Scaffold & frontend | Project scaffolding; UI with natural-language intent parser, route comparison table, execution stepper and live charts (SSE); one-command demo script; demo recording guide |
| Zhong Haoyang | Smart contracts | `IntentSettlement` with chain-bound EIP-712 signatures, replay/expiry/fee-cap protections; `MockERC20` + `MiniAMM`; 23 Foundry tests incl. fuzzing; design doc & architecture diagram |
| Mo Fan | Routing core | EIP-712 intent encoding; fee / latency / success-probability model; weighted routing algorithm with hard constraints and plain-English explanations; 47 unit tests; README |
| Tian Zhenman | Chain infrastructure | 3-rollup Anvil devnet with distinct per-chain profiles; live monitor, relayer with nonce queue, chaos controls; 10 end-to-end tests on fresh chains; test report |
| Jiao Haozhe | Service & simulation | Intent lifecycle service with deadline-based safe re-routing; REST + SSE server; offline load simulator reusing the production router; live benchmark and results analysis |
