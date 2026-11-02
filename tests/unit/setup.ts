// Env for tests: the app reads Vite env vars through import.meta.env (process.env under Bun). Every unit and
// frontend test file imports this first. `bun test` runs all files in one process and contracts.ts reads the
// env once, so every file must agree on these values.
process.env.VITE_MARKET_ADDRESS ??= '0xad96602776250f18a4d46ab7b2f0c56a5fda2df5'
process.env.VITE_ORACLE_ADDRESS ??= '0x465ec9f24ad95cdb73c72b2de1ccb0ac827723e3'
process.env.VITE_FEED_BTC ??= '0x83eec3cbda541e441ff5f919fa47faefb20678ae'
process.env.VITE_FEED_ETH ??= '0xc7e7bcd1e9a28cecb58dad6a4459b9f81db4c970'
process.env.VITE_FEED_SOL ??= '0x4395f10c126fbfb0b3b229648ceeba4bd7fca004'
process.env.VITE_KEEPER_ADDRESS ??= '0x3F04776B2b253abdC3DF386d82Bc182BE674BF7f'
process.env.VITE_DEPLOY_BLOCK ??= '1'
