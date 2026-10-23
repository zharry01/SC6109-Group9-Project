// Profiles of the simulated rollups. Each one is a real local Anvil chain whose
// block time, block gas limit (capacity) and sequencer ordering are set from here.
// The L1 data-availability fee cannot be produced by Anvil, so it is modelled
// off-chain from the real calldata size (see src/core/feeModel.js).

export const ETH_USD = 3000; // fixed oracle price used for USD conversions
export const USDC_USD = 1;

export const ROLLUPS = [
  {
    id: 'A',
    name: 'Rollup A',
    label: 'Optimistic · Fast',
    type: 'optimistic',
    port: 8545,
    chainId: 901,
    blockTimeSec: 1,
    blockGasLimit: 1_200_000, // ~8 intent fills per block
    priorityFeeGwei: 0.05, // sequencer tip floor; L2 gas price = base fee + tip
    l1FeeGweiPerByte: 30, // modelled DA cost per calldata byte (posts to Ethereum calldata)
    settlement: 'Optimistic: ~7-day challenge window for L1 finality',
    color: '#e8734a',
    // AMM depth on this rollup: deep pool, mid price
    pool: { usdc: 600_000, weth: 200 },
  },
  {
    id: 'B',
    name: 'Rollup B',
    label: 'ZK · Batch (cheap, slow)',
    type: 'zk',
    port: 8546,
    chainId: 902,
    blockTimeSec: 4,
    blockGasLimit: 4_000_000, // ~26 fills per block (big batches)
    priorityFeeGwei: 0.01,
    l1FeeGweiPerByte: 5, // compressed batches / blobs
    settlement: 'ZK validity proof: L1 finality after proof (~1h)',
    color: '#4a90d9',
    // shallow pool, slightly better price
    pool: { usdc: 59_700, weth: 20 },
  },
  {
    id: 'C',
    name: 'Rollup C',
    label: 'Appchain · Balanced',
    type: 'optimistic',
    port: 8547,
    chainId: 903,
    blockTimeSec: 2,
    blockGasLimit: 900_000, // small capacity, congests easily
    priorityFeeGwei: 0.02,
    l1FeeGweiPerByte: 12, // alt-DA committee
    settlement: 'Optimistic + external DA committee (extra trust assumption)',
    color: '#5bb174',
    pool: { usdc: 150_000, weth: 50 },
  },
];

export const rpcUrl = (r, host = '127.0.0.1') => `http://${host}:${r.port}`;

// Well-known Anvil dev accounts (mnemonic "test test ... junk"). Never use on a real network.
export const ACCOUNTS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  relayer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  alice: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  bob: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  carol: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  merchant: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  spammer: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
};

// Initial token balances (human units) per demo user per rollup.
export const USER_BALANCES = {
  alice: { A: { usdc: 5_000, weth: 2 }, B: { usdc: 2_000, weth: 2 }, C: { usdc: 50, weth: 1 } },
  bob: { A: { usdc: 1_000, weth: 1 }, B: { usdc: 1_000, weth: 1 }, C: { usdc: 1_000, weth: 1 } },
  carol: { A: { usdc: 300, weth: 0.5 }, B: { usdc: 300, weth: 0.5 }, C: { usdc: 300, weth: 0.5 } },
};

export const TOKENS = {
  usdc: { symbol: 'USDC', decimals: 6, usd: USDC_USD },
  weth: { symbol: 'WETH', decimals: 18, usd: ETH_USD },
};

export const ROUTER = {
  intentTtlSec: 15, // signed intent deadline; also bounds how long a stuck tx can block re-routing
  receiptGraceSec: 3, // wait past the deadline before declaring a submission dead
  relayerMargin: 0.1, // relayer charges estimated cost + 10%
  stallFactor: 3, // no new block for 3x block time => rollup considered stalled
};
