# Demo 视频录制指南（约 10 分钟）

每一步写清楚：**屏幕上做什么**、**应该看到什么**、**旁白（英文，可照读或改写）**。
所有路由结果都已在全新状态下验证过；如果屏幕结果和这里不一致，通常是因为没有从全新状态开始（见第 0 步）。

---

## 第 0 步：录制前准备（不录）

### 0.1 重启到干净状态

每次正式录制前都要重启，保证余额、成功率、历史记录都是初始值。

```bash
pkill -f scripts/demo.js; pkill -f anvil
```

```bash
cd cross-rollup-intent-router && npm run demo
```

等终端打印 `Intent router UI ready: http://localhost:3000`（约 10 秒）。**这个终端不要关**，录完按 Ctrl+C 停止。

### 0.2 准备第二个终端（用于第 7、8 步）

```bash
cd cross-rollup-intent-router
```

### 0.3 浏览器与录屏设置

- 用 Chrome 打开 `http://localhost:3000`，窗口宽度 ≥ 1280（三张 Rollup 卡片要横排显示），隐藏书签栏，关闭无关标签页和通知（macOS 勿扰模式）。
- 页面缩放建议 90%（Cmd + -），让"意图表单 + 路由表"在一屏内。
- 录屏：macOS 按 **Cmd+Shift+5** → "录制整个屏幕"或"录制所选部分"，"选项"里选麦克风；或用 OBS。
- 准备好幻灯片（架构图 `docs/architecture.svg` 可直接放进去）。

### 0.4 先完整彩排一遍

彩排后**再执行一次 0.1 重启**，然后正式录制。

---

## 时间分配

| 段落 | 时长 | 内容 |
|---|---|---|
| 1 | 1:00 | 开场 + 架构（幻灯片） |
| 2 | 1:30 | 基本转账：意图 → 路由 → 执行 |
| 3 | 1:00 | 偏好与约束改变路由 |
| 4 | 0:30 | 商户支付 |
| 5 | 1:00 | Swap 与流动性 |
| 6 | 1:30 | 拥堵注入 |
| 7 | 1:30 | 宕机与安全重路由 |
| 8 | 1:00 | 测试与分析图表 |
| 9 | 0:30 | 总结 |

---

## 第 1 步：开场与架构（1:00，幻灯片）

**屏幕**：显示架构图幻灯片。

**旁白**：
> Hi, we are Group __. Our project is Option 6, a cross-rollup intent router. In a modular Ethereum, users face many rollups with different fees, speeds and trust assumptions. Our system lets a user state *what* they want, and the router decides *where* it runs.
>
> We run three real local EVM chains as rollups. Rollup A is fast but expensive, B is a cheap but slow ZK-style batch rollup, and C is an appchain with small capacity and an alternative DA layer. The same settlement contract is deployed on each. The off-chain router monitors all three, quotes, scores and explains a route, then the user signs an EIP-712 intent and our relayer executes it.

---

## 第 2 步：基本转账（1:30）

**屏幕**：切到浏览器，先停在顶部的三张 Rollup 卡片上 2 秒。

**旁白**：
> At the top is live data from the three rollups: block number, block time, gas price, estimated fee and latency, congestion and a success probability.

**操作**：在 "Describe your intent" 输入框输入：

```
send 100 USDC to Bob as cheap as possible
```

按回车（或点 Parse）。

**应该看到**：表单自动填好（Alice / Transfer / 100 USDC / Bob / Cheapest），右侧路由表出现：**Rollup B = chosen**，A 是 #2，**C 被 excluded（Alice 在 C 上只有 50 USDC）**。

**旁白**（指着路由表）：
> The parser filled the form. The router compared all three rollups. B is chosen because it is 83% cheaper than A. The bar shows the score split into cost, latency and risk. C is excluded because Alice only has 50 USDC on C. The router checks balances on every rollup before routing.

**操作**：点 **Sign & execute →**，页面滚到 "Execution status"。

**应该看到**：步骤条依次变绿 Received → Routed → Signed → Submitted → Confirmed；右侧显示 "Executed on Rollup B"、交易哈希、区块号、费用、实际延迟 vs 预估延迟。

**旁白**：
> Alice signs an EIP-712 intent that is bound to Rollup B only. The relayer submits it, and it is confirmed on-chain. Here is the transaction hash, the fee charged, and the actual inclusion time compared with our estimate.

---

## 第 3 步：偏好与约束（1:00）

**操作 1**：把 Routing preference 切到 **⚡ Fastest**，点 **Compare routes**。

**应该看到**：**Rollup A chosen**（"83% more expensive, 1.5s faster"）。

**旁白**：
> Same intent, but now the user prefers speed. The router picks A, the fastest rollup, and explains the trade-off: more expensive, but 1.5 seconds faster.

**操作 2**：User 改为 **Bob**，preference 切回 **💰 Cheapest**，展开 "Constraints & demo options"，**Max latency** 填 `1.5`，点 **Compare routes**。

**应该看到**：**Rollup C chosen**，**B excluded：latency 2.0s exceeds your max 1.5s**。

**旁白**：
> Users can also set hard constraints. Bob wants the cheapest route but within 1.5 seconds. B is the cheapest but too slow, so it is excluded, and C wins.

**操作 3**：把 Max latency **清空**（后面步骤不需要）。

---

## 第 4 步：商户支付（0:30）

**操作**：User = **Bob**，Intent 点 **Payment**（Recipient 自动变为 Coffee Shop），Amount 填 `4.5`，Merchant order reference 保持 `ORDER-1001`，preference 选 **Fastest**，点 **Sign & execute →**。

**应该看到**：在 Rollup A 上 Confirmed。

**旁白**：
> A merchant payment carries an order reference that is hashed into the signed intent and emitted on-chain, so the merchant can reconcile the payment.

---

## 第 5 步：Swap 与流动性（1:00）

**操作 1**：User = **Alice**，Intent 点 **Swap**，Amount `300` USDC，Receive = WETH，preference = **Balanced**，点 **Compare routes**。

**应该看到**：**B chosen**，表里多了 "You receive" 和 "impact" 列，说明里有 "$0.15 more swap output"。

**旁白**：
> For swaps, the router also compares the output of each rollup's AMM pool. For 300 USDC, B gives the best price and the lowest fee.

**操作 2**：Amount 改为 `3000`，点 **Compare routes**，然后点 **Sign & execute →**。

**应该看到**：**A chosen**；B、C 都 excluded，原因含 **"insufficient pool liquidity: price impact 4.58% > 2%"**。执行后在 A 上 Confirmed。

**旁白**：
> For a large swap of 3000 USDC, B's pool is too shallow: the price impact would be 4.6%, so it is excluded. A has the deepest pool. The signed intent includes a minimum output, so the contract reverts if slippage exceeds the user's tolerance.

---

## 第 6 步：拥堵注入（1:30）

**操作 1**：滚到顶部，点 **Rollup B** 卡片上的 **🚦 Congest**。

**应该看到**（2–4 秒内）：B 卡片 pending tx 变成上千，Congestion 条变满（100%），Est. latency 变成 20 多秒，随后 L2 gas price 和 Est. fee 上升。

**旁白**：
> Now we simulate a popular app launching on Rollup B. We flood its sequencer with over a thousand transactions and spike its base fee. You can see the pending queue, congestion, latency and fee all rising.

**操作 2**：User = **Bob**，Intent = **Transfer**，Amount `20`，Recipient = Carol，preference = **Cheapest**，点 **Compare routes**，然后 **Sign & execute →**。

**应该看到**：B 被 excluded，原因是 **"expected latency … would outlive the intent's validity window (12s)"**（或者因为费用变高排到后面）；路由到 **C**，Confirmed。

**旁白**：
> Even though B is normally the cheapest, the router now avoids it. Its expected latency is longer than the intent's 15-second validity window, so the intent would expire there. The intent goes to C instead. Users don't have to watch chain congestion themselves.

> 提示：B 的积压约 30 秒清空，但 base fee 会以每块 12.5% 的速度慢慢降回（约 2 分钟），这正好说明 EIP-1559 的费用恢复过程，可以顺口提一句。

---

## 第 7 步：宕机与安全重路由（1:30）

**操作 1**：User = **Bob**，Transfer，Amount `25`，Recipient = Carol，preference = **Balanced**，展开 "Constraints & demo options"，**勾选 "Simulate a sequencer outage…"**，点 **Sign & execute →**。

**应该看到**：
- 路由到某个 rollup（通常是 C），日志出现 **"Simulated sequencer outage: Rollup C stopped producing blocks"**；
- 顶部 C 卡片变成 DEGRADED → **STALLED**，Success prob 变 0%；
- 约 18 秒后日志出现 **"not included before deadline … Safe to re-route"**，接着 **"Re-routed to Rollup …"**，最终 Confirmed，"2 attempts (re-routed)"。

**旁白**（等待的 18 秒里讲）：
> Now the worst case: the sequencer of the chosen rollup goes down right after the user signed. The router detects that C has stopped producing blocks and marks it stalled. But it does not re-route immediately. The transaction is already in C's mempool, and if C comes back it could still execute, and the user would pay twice. So the router waits until the intent's deadline has passed. After that, the contract on C will reject the old transaction with an `Expired` error, and it is safe to sign a new intent for another rollup.

**操作 2**：**取消勾选** outage 选项。在结果的日志里找到 C 上那笔交易（"Relayer submitted fill on Rollup C: 0x…"），在 **Intent history** 里点开该记录也能看到。然后点 C 卡片上的 **▶ Resume**。

**操作 3**：在第二个终端证明旧交易被拒（把 `<TX_HASH>` 换成 C 上那笔交易的完整哈希。获取方式：浏览器打开 `http://localhost:3000/api/intents`，第一条记录的 `attempts[0].txHash`）：

```bash
cast receipt <TX_HASH> status --rpc-url http://127.0.0.1:8547
```

**应该看到**：`0 (failed)`。也可切到 **Balances** 标签，Carol 在 C 上的 USDC 余额没变。

**旁白**：
> After we resume C, the stale transaction is mined, but it reverts because the intent expired. Carol was paid exactly once, on the other rollup. This is enforced on-chain, not by trusting the router.

---

## 第 8 步：测试与分析（1:00）

**操作 1**（可选，建议剪辑加速）：第二个终端运行合约测试（约 2 秒）：

```bash
forge test
```

**旁白**：
> We have 23 contract tests including fuzzing, 47 unit tests and 10 end-to-end tests on real chains, covering replay, forged signatures, expiry, fee caps, slippage, cross-rollup signature isolation, and the outage scenario you just saw.

**操作 2**：浏览器点 **Live analytics** 标签。

**旁白**：
> Live analytics compares the router with always using one rollup, on the same intents.

**操作 3**：点 **Scalability simulation** 标签，依次指向 4 张图和最下面的 incident 图。

**旁白**：
> To study scalability we built a simulator that uses the same routing code. Any single rollup saturates at around 5 to 6 intents per second, and failures shoot up. The router spreads load across all three and keeps zero failures up to 14 intents per second. In the incident replay, where B is congested and C goes down, users pinned to C lose 78% of their intents, while the router stays near zero. On real chains at 20 intents per second, the router achieved 100% success, faster and about 3.6 times cheaper than always using the fast rollup.

---

## 第 9 步：总结（0:30，可回到幻灯片）

**旁白**：
> To summarize: users express outcomes, and the router turns many fragmented rollups into one usable system. It improves throughput, cost and fault tolerance. The trade-off is that the router and the relayer allow-list are centralization points. They can affect liveness and routing quality but cannot steal funds, which is guaranteed by the contract. Decentralizing them with bonded solvers and competing routers is future work. Thank you.

---

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 路由结果和指南不一样 | 没有从全新状态开始 → 执行 0.1 重启 |
| C 一直显示 STALLED | 第 7 步后忘了点 **Resume** |
| B 在第 6 步后很久还是贵 | base fee 正在按 EIP-1559 慢慢回落（约 2 分钟），属正常；需要的话重启 |
| 页面显示 "reconnecting…" | 运行 `npm run demo` 的终端被关了或报错，重新运行 |
| `npm run demo` 报端口被占用 | 先执行 0.1 里的 `pkill` 命令 |
| 卡片按钮点了没反应 | 按住稍久一点再松开，或再点一次（卡片每秒刷新） |

## 剪辑建议

- 第 7 步等待 18 秒可以保留（边等边讲原理），也可以 2× 加速。
- `forge test` / `npm test` 输出可以加速或只截最后的 "passed" 结果。
- 总时长控制在 10 分钟以内，超时优先压缩第 4、8 步。
