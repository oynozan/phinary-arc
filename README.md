# Phinary Arc

Onchain price prediction markets for BTC, ETH, SOL, Nvidia (NVDA) and Apple (AAPL) on Arc. Pick a strike price and a deadline, bet UP or DOWN with USDC, and sell back any time before the deadline. Odds come from a Black-Scholes model plus a small house edge, and a shared USDC vault that anyone can fund backs every payout. There are no tokens.

The app runs on Arc Testnet today. The code can also target Arc mainnet (Chainlink Data Streams prices, a deploy script), but nothing is deployed there; see [`arc-studio-plans/MAINNET_MIGRATION.md`](arc-studio-plans/MAINNET_MIGRATION.md) for what still has to happen first.

Built with [Arc Studio](https://studio.arc.io)

## What you can do

- Trade 5 minute, 15 minute and 1 hour markets with live odds, optionally with your own strike price. Crypto and stock markets both run around the clock.
- See your expected payout, profit, chance to win and fee before you bet. Previews are computed in the browser, and the "Max cost" row shows the most a bet can cost if the price moves before it lands.
- Watch a live price chart with the strike, the deadline and every bettor's avatar on the line. Crypto prices come from Coinbase, stock prices from Kraken's tokenized stocks (xStocks). Outside US market hours stock prices are tokenized-stock quotes, not the exchange price.
- Track open bets under the chart, close any of them with one click, and see the result the moment a market ends. Winnings and refunds from older markets stay listed until you claim them.
- Review every action in the History page.
- Set a stop loss and take profit on the underlying price. A keeper sells your position when the level is crossed, even if you are offline.
- Deposit into the vault to earn the house edge, and withdraw after the 1 hour lock. Deposits and withdrawals carry a minimum-output bound, so they revert instead of filling at a worse price.
- Claim winnings, or a refund if a market is voided.

## How prices settle

- Settlement and stop loss / take profit always use the on-chain oracle, never the chart.
- Testnet: mock Chainlink-compatible feeds that the keeper updates from Coinbase (crypto) and Kraken xStocks (stocks).
- Mainnet (when deployed): one `StreamsFeed` contract per asset, fed with signed Chainlink Data Streams reports that the Chainlink verifier checks on-chain. NVDA and AAPL use Chainlink's 24/7 equity streams.
- On testnet a market settles on the first oracle price at or after its deadline. On mainnet it settles on the earliest signed report observed in the 10 seconds after the deadline: anyone can submit one, an earlier report replaces a later one (or, in the same second, the one with the smaller report hash) for 5 minutes, after which it is final. Trading needs a recent oracle price, and the closer the deadline, the fresher it must be.

## Tech stack

- React, Vite, TypeScript, Tailwind CSS, framer-motion
- wagmi, viem, ConnectKit
- Recharts (shadcn chart components)
- Solidity 0.8.28 and Foundry
- Arc Testnet / Arc mainnet, USDC, live data over WebSocket (no polling)

## Development

Prerequisites: [Bun](https://bun.sh), [Foundry](https://getfoundry.sh). Copy `.env.example` to `.env` and fill it in.

```bash
bun install
bun run dev              # app on http://localhost:5173
bun run keeper           # keeper bot: prices, markets, settlement, SL/TP orders
bun run setup            # one-time wiring after a deploy (see below)
bun run contracts:build
bun run check            # lint + typecheck
```

### Tests

```bash
bun run contracts:test   # forge test: 271 contract tests
bun run test             # 154 unit and frontend tests
bun run test:keeper      # keeper end-to-end and unit tests on anvil (62, about 8 minutes)
bun run test:fork        # fork tests against Arc testnet and mainnet (needs network; set ARC_FORK_BLOCK to avoid RPC rate limits)
bun run test:live        # read-only checks against the live testnet deployment
```

### Deploying

```bash
OWNER=0x... bun run deploy:testnet   # simulate a full testnet deploy on a fork
OWNER=0x... bun run deploy:mainnet   # simulate a full mainnet deploy on a fork
```

These scripts only simulate; they cannot send transactions, even with extra flags. They print the `VITE_*` lines for `.env`. To deploy for real, run the same `forge script contracts/script/DeployPhinary.s.sol` command yourself with `--broadcast --sender $OWNER` and the owner's signer (`--account <keystore>` or `--private-key`).

Options: `ASSETS=0,1,2,3,4` deploys a subset (0 BTC, 1 ETH, 2 SOL, 3 NVDA, 4 AAPL). `ORACLE=<adapter>` adds the `ASSETS` feeds to an existing deployment instead (OWNER must own it), for example `ASSETS=3,4` to add NVDA and AAPL. With `ORACLE`, `ASSETS` is required, and an asset already enabled on that oracle is refused unless `REPLACE_FEEDS=1` (replacing a feed wipes its vol history and can mis-settle its open markets). `MAX_REPORT_AGE` (mainnet, default 5 seconds) limits how old a Data Streams report may be when it is submitted as a trading round; settlement reports have no age limit.

The deploy script deploys the feeds and registers them on the oracle with their vol bounds, but sets no price and deposits nothing. After a deploy, run `bun run gen:abis` if the contracts changed, then `bun run setup` once. On testnet it seeds every mock feed that has no price yet with a live spot price, registers any feed the deploy script did not, and seeds the vault from the keeper wallet. On mainnet (`NETWORK=mainnet`) it only checks each feed and submits one report; it deposits only if `DEPOSIT_USDC` is set.

### Environment variables

Variables starting with `VITE_` are bundled into the browser app. Never put a secret in one.

**App (also read by the scripts)**

| Name | Purpose |
| --- | --- |
| `VITE_NETWORK` | `testnet` (default) or `mainnet`. Any other value stops the app at load |
| `VITE_RPC_HTTP`, `VITE_RPC_WS` | Optional RPC overrides. Default to the public Arc RPC for the chosen network |
| `VITE_MARKET_ADDRESS` | Deployed market contract |
| `VITE_ORACLE_ADDRESS` | Deployed oracle adapter |
| `VITE_FEED_BTC`, `VITE_FEED_ETH`, `VITE_FEED_SOL`, `VITE_FEED_NVDA`, `VITE_FEED_AAPL` | Price feed per asset (mock feeds on testnet, `StreamsFeed` on mainnet). An asset appears only when its feed is set; at least one is required |
| `VITE_DEPLOY_BLOCK` | Block of the deployment, used to bound event scans |
| `VITE_KEEPER_ADDRESS` | Public keeper address, or several separated by commas |

**Scripts only (keeper, setup)**

| Name | Purpose |
| --- | --- |
| `NETWORK` | `testnet` (default) or `mainnet`. Must match `VITE_NETWORK` |
| `RPC_URL` | Optional RPC override |
| `KEEPER_PRIVATE_KEY` | Keeper wallet key. Never exposed to the browser |
| `KEEPER_PUSH_PRICES` | `false` stops the keeper from updating prices |
| `KEEPER_COUNT`, `KEEPER_INDEX`, `KEEPER_PEERS` | Run several keepers side by side: same count (an integer of at least 1), a distinct 0-based index each (below the count, or the keeper refuses to start), the other keepers' addresses (comma separated). Each needs its own key |
| `STREAMS_API_KEY`, `STREAMS_API_SECRET` | Chainlink Data Streams credentials. Required for the mainnet keeper unless `KEEPER_PUSH_PRICES=false` |
| `STREAMS_API_URL` | Optional Data Streams API base URL |
| `STREAMS_FEED_ID_<ASSET>` | Optional stream id that `setup` expects each mainnet feed to use |
| `DEPOSIT_USDC` | Vault deposit amount for `setup` (mainnet deposits only when set) |
| `SETUP_FORCE` | `1` makes testnet `setup` re-seed and re-register feeds and deposit again |
| `COINBASE_API_URL`, `KRAKEN_API_URL` | Optional price source overrides for the testnet keeper |
| `RPC_PROXY_BASE_URL`, `RPC_PROXY_TOKEN`, `RPC_PROXY_CHAINS` | Optional, Arc Studio only. Testnet scripts fall back to the public Arc RPC |

**Deploy script and fork tests**: `OWNER`, `ASSETS`, `ORACLE`, `MAX_REPORT_AGE` (see Deploying), `ARC_FORK_BLOCK` (pins fork tests to a block).

## Notes

- The live testnet contracts are an older build than the source in this repository. Redeploy before using the current app against testnet; vault deposits and withdrawals in particular need the new contracts.
- The mock feeds give the keeper full control of testnet prices. They must never back real funds.
- The contracts have tests and an automated review but no independent audit. Do not use them with real money.
