# Phinary Arc

> Built with Arc Studio - money-powered apps in minutes

Project memory for future agents.

## What This App Does

Binary prediction markets (UP/DOWN vs a strike at a deadline) for BTC, ETH, SOL and the stocks NVDA, AAPL on Arc. Testnet is live; mainnet is wired in code (network switch, Chainlink Data Streams feed, deploy script) but not deployed. Odds are Black-Scholes (r = 0, EWMA vol from the oracle) plus a house edge. A shared USDC vault backs payouts and earns the edge. No tokens: positions and vault shares are internal accounting. Users can sell back before expiry and set stop-loss / take-profit on the underlying price; the keeper (or anyone) executes them.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind, framer-motion, Recharts via shadcn chart (`src/components/ui/chart.tsx`)
- Web3: wagmi v2, viem, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry in `contracts/`. Tests: `contracts/test/` (272 passing, `forge test`), fork tests in `contracts/test-integration/fork/` (`bun run test:fork`, `FOUNDRY_PROFILE=integration`; forks Arc testnet and mainnet)
- TS tests: `tests/unit` + `tests/frontend` (157, `bun run test`), `tests/keeper` (65 anvil e2e + unit, `bun run test:keeper`, ~8 min), `tests/live` (read-only probes of the live testnet, `bun run test:live`)
- Chains: Arc Testnet (5042002) and Arc mainnet (5042). USDC `0x3600...0000` on both (6 decimals ERC-20; native gas is the same balance at 18 decimals)
- Fonts: Akt (primary), Manrope (numbers). Palette: #1083FF main, #97CB3D success/UP, #F44708 fail/DOWN, white text, opaque navy surfaces (canvas, card, raised, hover; each nesting level one step lighter, no borders).
- Design rules (enforced in `tailwind.config.js`): five font sizes only (12, 14, 16, 24, 40); radii card 24 > inner 16 > control 12 > badge 8; sentence case; one secondary text tone (`text-dim`); selected = filled (blue by default, green/red for Up/Down). Explanations go in `HelpTip` tooltips, never captions. Stocks use a white monogram badge (no stock logos in @web3icons).

## Architecture notes

- Network switch: `VITE_NETWORK` (frontend, `src/lib/network.ts` is the only source of chain/RPC/`isTestnet`) and `NETWORK` (scripts, `scripts/lib.ts`), each `testnet` (default) or `mainnet`; any other value throws. `VITE_RPC_HTTP`/`VITE_RPC_WS`/`RPC_URL` override RPCs. viem's `arc` chain has no WS URL, so `network.ts` spells out `wss://rpc.mainnet.arc.io`.
- Assets: BTC 0, ETH 1, SOL 2, NVDA 3, AAPL 4. An asset exists in the UI, keeper and setup only when its `VITE_FEED_<KEY>` is set; feeds are keyed by asset id, not array index. The live testnet has no NVDA/AAPL feeds yet, so it shows three assets.
- No polling. `src/lib/realtime.ts` holds one viem WebSocket client; `src/hooks/useRealtimeSync.ts` subscribes to contract events, feed price updates and USDC transfers and writes into the react-query cache. Feed updates: Chainlink `AnswerUpdated` (StreamsFeed and current mocks) plus the old mocks' `PriceSet`, deduped per feed by roundId, scaled by each feed's `decimals()`. `getVol` is re-read on every new round and written with the spot in one step. Query hooks live in `src/hooks/data.ts` and keep previous data while refreshing (no loading flicker).
- Odds are computed in the browser with `src/lib/pricing.ts`, a port of the contract formula (`bun run scripts/quote-parity.ts` checks parity). The contract is only called to bet. A custom strike opens a market in the same flow as the bet.
- Buy sizing (`src/lib/bet.ts`): units = stake / current price; `maxCost` = min(balance, worst-case cost over a 2-sigma-in-45s move, floor 5 bps). A capped bet reverts rather than shrinking.
- Markets are selected by duration (5m, 15m, 1h), not id, so the view moves to the next market without a reload. Rolling markets are those created by any address in `VITE_KEEPER_ADDRESS` (comma list).
- Chart (display only; settlement is always the oracle): crypto from Coinbase WS, stocks from Kraken xStocks (keyless, 24/7; REST 1m OHLC backfill + WS v2 `book` mid, depth 10) in `src/hooks/useKrakenPrice.ts`. Shared stream/backoff/watchdog in `useCoinbasePrice.ts` (`streamPrices`). Off-hours stock prices are tokenized-stock quotes, disclosed in a HelpTip.
- Positions live under the chart on the Trade page: recent markets plus every older market the wallet bought into (its own `Bought` logs from `VITE_DEPLOY_BLOCK`, then incremental), so a win or refund stays claimable however old. History (`src/hooks/history.ts`) scans events from `VITE_DEPLOY_BLOCK` incrementally; an `OrderExecuted` relabels its same-tx `Sold` row. Log chunks stay under Arc's 10,000-block `eth_getLogs` limit.
- Logo: `src/logo.svg` is the original upload (1254x1254 canvas). `src/assets/logo-mark.svg` is the same white artwork with the viewBox cropped to the glyph; the header uses that one.

## Deployed

Arc Testnet (live):
- PredictionMarket: `0xad96602776250f18a4d46ab7b2f0c56a5fda2df5`
- PriceOracleAdapter: `0x465ec9f24ad95cdb73c72b2de1ccb0ac827723e3`
- Mock feeds: BTC `0x83eec3cbda541e441ff5f919fa47faefb20678ae`, ETH `0xc7e7bcd1e9a28cecb58dad6a4459b9f81db4c970`, SOL `0x4395f10c126fbfb0b3b229648ceeba4bd7fca004`. NVDA/AAPL not deployed (add with `ORACLE=<adapter> ASSETS=3,4`, see below; only simulated so far).
- These bytecodes predate the current source (checked with `cast code`: no `deposit(uint256,uint256)`, `withdraw(uint256,uint256)`, `ORACLE_AGE_RATIO`, `MIN_RESIDUAL_SHARES` or oracle `LAMBDA`). `src/lib/abis.ts` matches the source, so vault deposit/withdraw from the current UI fail against them, and the EWMA vol, oracle-age guard and last-LP rule are not live until a full redeploy (`deploy:testnet` without `ORACLE`, then update `.env`).
- Owner of all four contracts: keeper wallet `0x3F04776B2b253abdC3DF386d82Bc182BE674BF7f` (key in `.env` as `KEEPER_PRIVATE_KEY`). Ownership is two-step (`transferOwnership` then `acceptOwnership`); renouncing is disabled.
- Addresses are mirrored in `.env` as `VITE_*` (template: `.env.example`).

Arc mainnet: nothing deployed. Chainlink VerifierProxy `0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7` (testnet `0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64`), both "VerifierProxy 2.0.0", fee manager 0, no access controller (checked on-chain). Chainlink Data Feeds exist on Arc mainnet for crypto only and update every 25 min to hours, too slow for 5m-1h markets; no NVDA/AAPL feed of any kind exists there. Mainnet plan and gates: `arc-studio-plans/MAINNET_MIGRATION.md`.

## Key Files

- `contracts/PredictionMarket.sol`: markets, trading, settlement, vault, SL/TP orders
- `contracts/PriceOracleAdapter.sol`: feed registry, staleness, EWMA vol, settlement round check
- `contracts/StreamsFeed.sol`: AggregatorV3 feed built from verified Chainlink Data Streams reports (mainnet); `submit(fullReport)` is permissionless
- `contracts/MockAggregator.sol`: keeper-pushed feed, testnet only. Never on mainnet
- `contracts/lib/BlackScholesLib.sol`: ln/exp/sqrt/normal CDF and the binary price
- `contracts/script/DeployPhinary.s.sol`: full deploy or add-feeds deploy for either network
- `src/lib/abis.ts`: generated by `bun run gen:abis` (market, oracle, aggregator, streamsFeed). Regenerate after contract changes
- `src/lib/network.ts`, `src/lib/contracts.ts`: network, RPCs, addresses, assets
- `src/lib/vault.ts`: `maxWithdrawShares` (residual-share cap)
- `src/components/PriceChart.tsx`: Coinbase/Kraken line + strike + oracle marker + deadline + SL/TP lines + bettor avatars
- `scripts/keeper.ts`: price push / report relay, oracle poke, market rotation, settlement, order execution
- `scripts/setup.ts`: after `DeployPhinary.s.sol` (which deploys and registers the feeds but sets no price): testnet seeds every mock feed with no round yet, registers any unregistered feed, seeds the vault; mainnet verifies the feeds
- `tests/keeper/harness.ts`: anvil + RPC fault hook + mocked Coinbase/Kraken/Data Streams APIs (HMAC-checked)

## Design decisions

- Vol: time-consistent EWMA, LAMBDA 0.94 per 60s, lambdaEff = 0.94^(dt/60), var = lambdaEff*var + (1-lambdaEff)*r^2*YEAR/dt, seeded at defaultVol^2, capped at maxVol^2; gaps of 1 day+ take the sample only. Delaying an observation does not shrink a jump's weight (VOL-GLIDE regression test). `poke` and the provisional step in `getVol` act only on a feed round newer than the last observed one (compared by feed `updatedAt`, so a late-landing Streams report still counts). Keepers push or submit before poking.
- Edge 1% to 5% (`MIN_EDGE` 0.01, `MAX_EDGE` 0.05; default 2%). Fair price clamped 0.02-0.98; buys at 0.99+ revert.
- Trading needs an oracle price no older than `maxTradeStaleness` (120s) AND oracle age * `ORACLE_AGE_RATIO` (4) <= time left (`OracleTooOldForExpiry`). Oracle-update front-running is still a documented residual risk of oracle-priced markets.
- Vault: deposits are priced at HIGH NAV (balance net of unclaimed payouts), withdrawals at LOW NAV (also net of worst-case open-market reserves incl. void refunds); the haircut goes to remaining LPs. `deposit(amount, minShares)` and `withdraw(shares, minAmount)` revert `SlippageExceeded`. Reserve per market = max(sell-back reserve, void refund), sell-back reserve = max(up,down) + ceil(0.99 * min) so sell-backs always stay possible.
- Residual LP risk (not fixed): HIGH NAV counts open-market trader collateral, so an incumbent LP holding a large position can inflate it right before a newcomer's deposit and dilute them; `minShares` only bounds the loss. A full fix needs mark-to-model or epoch accounting. Mainnet launch gate.
- Last LP: while reserves are open, at least `MIN_RESIDUAL_SHARES` = 1e9 (one display share) must stay outstanding (`LastLpWhileExposed`); the UI caps every withdraw chip to it.
- Settlement requires the first oracle round at or after expiry; a feed phase-boundary round is rejected (market then voids after 24h with cost refunds). Ties resolve DOWN.
- StreamsFeed: schemas v3 (BTC/ETH/SOL), v2 (NVDA/AAPL 24/7 streams, the default so stock markets run around the clock), v8 accepted only while `marketStatus == 2`; v11 unsupported. Trading round (`submit`) = report observation time; reports older than `maxReportAge` (deploy default 5s) or from the future revert; an equal/older report returns false. Reverts `FeesNotSupported` if a fee manager is ever set (redeploy then). Decimals is a constructor arg (deploy passes 18) and is unconfirmed: check the first real report against Kraken/Coinbase before opening markets. Settlement does not use trading rounds: `submitSettlement(report, expiry)` keeps the earliest report observed in [expiry, expiry + `SETTLE_WINDOW` 10s], any age accepted; an earlier report replaces a later one for `DISPUTE_PERIOD` (300s) after the first submission, a same-second tie goes to the smaller keccak256 of the verified report data (several reports can share one whole-second observationsTimestamp), every record (exact-expiry included) is final only after `DISPUTE_PERIOD`, a final record never changes. The adapter detects such a feed in `setFeed` (`SETTLE_WINDOW()` answers) and `settlementPrice` ignores roundId for it (`settle(id, 0)`); no report means the market voids after 24h. Residual (not fixed): latency arbitrage of instantly priced trades; the full fix is two-step, delayed execution.
- Keeper: testnet pushes Coinbase (crypto) / Kraken xStocks mid (NVDA/AAPL; rejects crossed books and spreads over 2%) to mocks on a 45s heartbeat or 2 bps move, whenever the age could break `age * 4 <= time left` of an open market before the next tick's push lands (`ageRuleDue` in `scripts/lib.ts`, 15s lag), every change within 255s of expiry, and holds a 20%+ jump until the next tick confirms it. Mainnet relays the latest signed Data Streams report (HMAC auth, `STREAMS_API_KEY/SECRET`; exits without them) to each StreamsFeed under the same triggers, only if it is within the feed's `maxReportAge` on inclusion (age against the later of chain and host time, plus 2s; one refetch, else the next tick), and never invents prices. Mainnet settlement: per (feed, expiry) it fetches the report at expiry (`GET /api/v1/reports?feedID=&timestamp=`, else the earliest in-window one from `/api/v1/reports/page`), submits it via `submitSettlement` whenever it is earlier than the stored record (overriding a later one someone else stored), then `settle(id, 0)` once the record is final; only an HTTP 404 means "no report". Startup log scan runs in the background: pushes, orders and settlement never wait, only rotation does, and it never voids before the scan catches up. RPC transport errors in the settlement round search are retried, never treated as "no round". Multiple keepers: `KEEPER_COUNT`/`KEEPER_INDEX`/`KEEPER_PEERS` (validated at startup), one key each; index 0 alone pushes and pokes, others step in 30s after it is overdue.
- Avatars are address-based Gravatar identicons (no email).
- Deploy (`bun run deploy:testnet|deploy:mainnet`) only simulates on a fork; extra args land on a trailing echo, so it can never broadcast. A real deploy is forge run by hand with `--broadcast --sender $OWNER` plus a signer. Mainnet guards: chain id, USDC 6 decimals, verifier code, zero fee manager. Feeds get maxStaleness 600 and vol bounds BTC .30/1.5/.55, ETH .40/2.0/.75, SOL .50/2.5/.95, NVDA .25/1.5/.50, AAPL .15/1.0/.30.

## Known issues

- `bun run typecheck` fails only on `scripts/compass-deploy.ts` (`@circlefin/compass-chains` not installed); pre-existing.
- `LiveDeployment.t.sol` head-solvency fork test can hit `rpc.testnet.arc.io` 429s; pin `ARC_FORK_BLOCK` or retry.
- StreamsFeed's accepting path is tested only with `MockVerifierProxy`; no real signed report yet (no Streams credentials). The Data Streams `GET /api/v1/reports?timestamp=` semantics (exact second or nearest) are not documented; the keeper checks the window itself and falls back to `/reports/page`.
- An exact gas estimate for `buy`/`sell`/`executeOrder` runs out of gas when the oracle's 60s observation interval elapses between the estimate and the block (the embedded `poke` then writes). The keeper's `executeOrder` and `tests/keeper` `Chain.tx` (`withHeadroom`) add 25%; the frontend relies on the wallet's headroom.

## Share links

- Starter apps already ship `getShareBase`, `buildShareLink` and `installShareSync` in `src/lib/share.ts`; import them instead of rewriting them.
- Keep shareable state in the URL path or query, not in the `#fragment`.
- Never put a secret in the URL path or query. A bearer claim secret goes only in the `#fragment`.
- Keep the `installShareSync()` call in `src/main.tsx` when editing it.

## To Run

```bash
bun install
bun run dev
bun run keeper                     # NETWORK=mainnet needs STREAMS_API_KEY/SECRET
bun run test && forge test         # fast suites
bun run test:keeper                # anvil e2e, slow
OWNER=0x... bun run deploy:testnet # fork simulation only
```
