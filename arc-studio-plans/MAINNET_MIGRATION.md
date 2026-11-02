# Mainnet migration guide: Phinary Arc

Status, November 2026: the repository can now target Arc mainnet, but nothing has been deployed there. The network switch, a Chainlink Data Streams price feed contract, a deploy script and the keeper's report relay are implemented and tested, and the mainnet deploy has been rehearsed on a fork. What remains is work for your team: Chainlink credentials, an audit, legal advice, governance, vault accounting, caps and monitoring. Section 1 lists every gate with its state.

Arc Studio builds and deploys on Arc Testnet only, so a mainnet deploy is done by you, outside Arc Studio. The contracts have tests and an automated review but no independent audit. They must not hold real funds as they stand.

Facts marked "checked on-chain" were read with `cast` on 2026-11-01. Everything else comes from Chainlink's and Circle's public pages read the same week. Re-check each one before relying on it. Feed addresses, schemas and fees change.

---

## 1. Go / no-go gates

Do not deploy to mainnet until every open box is ticked.

- [x] Oracle strategy decided and implemented: Chainlink Data Streams through `contracts/StreamsFeed.sol` (section 2). The mainnet deploy path never deploys `MockAggregator`.
- [x] Network switch in the app and scripts (`VITE_NETWORK`, `NETWORK`).
- [x] Deploy script with mainnet guards, rehearsed on a mainnet fork (section 6).
- [ ] Chainlink Data Streams API credentials obtained, and the first real signed report for every stream submitted and checked (section 3, item 1). Until then the accepting path of `StreamsFeed` has only been tested against a mock verifier.
- [ ] Independent smart-contract audit of the final contracts, including `StreamsFeed`; all high and medium findings fixed and re-reviewed.
- [ ] Legal advice for each launch jurisdiction. Binary prediction markets are regulated in many places, and binaries on single stocks (NVDA, AAPL) are heavily regulated. Get specific advice before offering them, or launch with crypto only.
- [ ] Vault accounting fixed: deposits are priced at HIGH NAV and can be diluted by an incumbent LP holding a large position (section 3, item 5). Needs mark-to-model or epoch accounting.
- [ ] Contract owner is a multisig behind a timelock, not a single key.
- [ ] Deposit cap, per-market exposure cap and per-user position cap implemented and tested.
- [ ] Monitoring, alerting and an incident runbook exist and have been rehearsed on testnet (sections 9 and 10).
- [ ] A rollout plan with small caps is approved (section 8).

## 2. Oracle decision (done)

### 2.1 Why Data Streams
Measured on Arc mainnet on 2026-11-01 (checked on-chain):

- **Chainlink Data Feeds exist for crypto only and are too slow.** BTC/USD updates on a 0.1% move or a 24h heartbeat, ETH and SOL on 0.5% or 24h. Over the last 15 rounds the median gap was about 25 minutes for BTC and 1.3 to 1.5 hours for ETH and SOL, with a worst case of 16.6 hours. With a 120 second trade staleness limit, trading would revert almost all the time, and 5 to 60 minute markets would settle hours late.
- **No NVDA or AAPL feed of any kind exists on Arc mainnet** (Chainlink Data Feeds, RedStone, Pyth, Stork), and no NVDA or AAPL tokenized stock is deployed there.
- **Pull oracles are the only route.** Chainlink Data Streams and Pyth Core both work by having someone post a signed report, and both need an API key (Pyth Hermes now returns 401 without one).

Data Streams was chosen. Each asset gets a `StreamsFeed` contract that verifies a signed report through Chainlink's VerifierProxy and exposes the standard AggregatorV3 interface, so `PriceOracleAdapter` and `PredictionMarket` needed no change to read it. The keeper relays reports; anyone else may too.

### 2.2 Verified Arc mainnet values

| Item | Value | Source |
|---|---|---|
| Chain id | `5042` | checked on-chain |
| HTTP RPC | `https://rpc.mainnet.arc.io` (others: blockdaemon, drpc, quicknode, Alchemy) | Arc docs |
| WebSocket | `wss://rpc.mainnet.arc.io` (works; not listed in the docs). Fallback `wss://rpc.blockdaemon.mainnet.arc.io/websocket` | tested |
| USDC (ERC-20) | `0x3600000000000000000000000000000000000000`, 6 decimals. Native gas is the same balance at 18 decimals | checked on-chain |
| Gas | Base fee 20 gwei, paid in USDC. Block time about 0.5 s, gas limit 30M | checked on-chain |
| `eth_getLogs` range | At most 10,000 blocks inclusive (to - from <= 9,999). The app and keeper fit | checked on-chain |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | checked on-chain |
| Explorer | `https://explorer.arc.io` | Arc docs |
| Data Streams VerifierProxy | `0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7`: "VerifierProxy 2.0.0", fee manager `0x0`, access controller `0x0`, owner `0x449fe191C50CDAcAAb2041381e64254D6c9173A4` | checked on-chain |
| Testnet VerifierProxy | `0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64`: "VerifierProxy 2.0.0", fee manager `0x0`, access controller `0x0` | checked on-chain |

Stream ids (the same on every network; default in `scripts/lib.ts` and the deploy script):

| Asset | Stream | Schema | Id |
|---|---|---|---|
| BTC/USD | crypto | v3 | `0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8` |
| ETH/USD | crypto | v3 | `0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9` |
| SOL/USD | crypto | v3 | `0x0003b778d3f6b2ac4991302b89cb313f99a42467d6c9c5f96f57c29c0d2bc24f` |
| NVDA/USD | 24/7 (used) | v2 | `0x0002d9b165cfb7309e8a13af14cbbb608d9990f9fa094d2ac6199d2567f2dae8` |
| AAPL/USD | 24/7 (used) | v2 | `0x000231a949aa4e6a24b2c2005b16e27d03ed90e08888a2da3a68ebc9c50763df` |
| NVDA/USD | equity, with market status (not used) | v8 | `0x0008adc184847ba8d17f0030c15e78f61b83eda2e190f30346c4ea3babed647d` |
| AAPL/USD | equity, with market status (not used) | v8 | `0x0008e64e9538dea4c50f9a8203d2c8993b6f3756da73cabafbb204637310c450` |

`StreamsFeed` accepts v2, v3 and v8 (v8 only while the market is open). Chainlink recommends schema v11 for US equities; it is not supported.

Chainlink Data Feeds on Arc mainnet, for reference or a sanity bound only (checked on-chain, 8 decimals): BTC/USD `0xa109B535C70C8Be9995be64Bb6751AcDB27e03De`, ETH/USD `0x50FCDD99D6762D1C170DC6A9111db944AEE6D364`, SOL/USD `0x2d04D354f5fDaE3De723df475745B0a9B4edf90C`.

### 2.3 Other decisions still open
- Who can deposit as a liquidity provider at launch: anyone, or an allowlist.
- Which jurisdictions are in scope, and whether you geo-block the others.
- The house edge (now 1% to 5%, default 2%).
- Whether NVDA and AAPL launch at all (legal), and on the 24/7 streams or the market-hours streams.

## 3. Contract changes

| # | Item | State |
|---|---|---|
| 1 | Remove the mock feed from production | **Done in the repo.** Mainnet deploys `StreamsFeed(verifierProxy, streamId, 18, name, 5)` per asset; `MockAggregator` is testnet-only. **Open:** the price scale of each stream is assumed to be 18 decimals and is not confirmed (Chainlink says 8 or 18 depending on the stream; the directory entries for the 24/7 equity streams are ambiguous). Compare the first real report of each stream against Coinbase/Kraken before opening markets, and redeploy that feed with the right decimals if it differs |
| 2 | Settlement rule | **Done for Streams.** Settlement no longer uses trading rounds. `StreamsFeed.submitSettlement(report, expiry)` keeps the earliest report observed in [expiry, expiry + 10 s] (`SETTLE_WINDOW`): an earlier report replaces a later one for 300 s after the first submission (`DISPUTE_PERIOD`), a same-second tie goes to the smaller hash of the verified report data, every record (exact-expiry included) is final only after those 300 s, and reports of any age are accepted, so nobody has to win a race at expiry and the first submitter cannot pick the price. `settle` passes roundId 0. The keeper fetches the report at expiry from the Data Streams API and submits it, overriding a later one someone else stored first. Trading rounds (`submit`) accept a report at most `maxReportAge` (5 s) old. With no settlement report the market voids after 24 h. **Residual:** latency arbitrage of instantly priced trades (a trader who sees a move before it lands on chain submits it and trades in one transaction); the full fix is two-step, delayed execution |
| 3 | Staleness | **Done.** Feeds use `maxStaleness` 600 s; trades need a price no older than 120 s, and oracle age x 4 must not exceed the time left (`OracleTooOldForExpiry`). The keeper pushes every change in the last 255 s of a market, and whenever the oracle age could break age x 4 <= time left before its next push lands |
| 4 | Volatility | **Done differently than first planned.** Instead of a pushed value, the ring buffer was replaced by an on-chain, time-consistent EWMA (0.94 per 60 s, capped at maxVol², clamped to [minVol, maxVol]) that only moves on a new feed round. Delaying an observation no longer changes a jump's weight (regression-tested) |
| 5 | Vault valuation and caps | **Partly done.** `deposit(amount, minShares)` and `withdraw(shares, minAmount)` have minimum-output bounds; while markets hold reserves at least `MIN_RESIDUAL_SHARES` (1e9, one display share) must stay outstanding. **Open:** deposits are priced at HIGH NAV, which counts open-market trader collateral, so an incumbent LP holding a large position can dilute a newcomer's deposit; `minShares` only bounds the loss. Needs mark-to-model or settlement-epoch accounting. Deposit, per-market and per-user caps do not exist yet |
| 6 | Governance | **Open.** Split the single owner into roles (parameters, pausing, feed changes). Move ownership of every contract to a multisig and timelock with the existing two-step transfer. Renouncing is disabled on purpose |
| 7 | Gas | **Open.** The 32-observation volatility loop is gone, so a buy should cost less than the old 2.4 million gas; re-measure on the final code |
| 8 | Keeper incentive | **Open.** The operator pays gas for settlement, orders and report relay. A small tip would let any party run a keeper; the functions are already permissionless |
| 9 | Fees on verification | **Handled.** The verifier's fee manager is zero today. If Chainlink sets one, `submit` reverts `FeesNotSupported` and a new feed contract is needed |

## 4. Repository changes

| File | State |
|---|---|
| `contracts/StreamsFeed.sol` | **New.** AggregatorV3 feed from verified Data Streams reports; 16 unit tests plus a fork test against the real mainnet verifier |
| `contracts/script/DeployPhinary.s.sol` | **New.** Full deploy or add-feeds mode, both networks, prints the `VITE_*` lines |
| `contracts/PriceOracleAdapter.sol` | **Done:** EWMA volatility, new-round gate on poke |
| `contracts/PredictionMarket.sol` | **Done:** oracle-age guard, edge floor 1%, min-output vault params, residual shares. **Open:** caps, role split |
| `contracts/MockAggregator.sol` | Testnet only; now also emits Chainlink's `AnswerUpdated` |
| `scripts/lib.ts`, `scripts/keeper.ts` | **Done:** `NETWORK` switch; on mainnet the keeper fetches the latest signed report from the Data Streams API (HMAC auth) and calls `StreamsFeed.submit`, never inventing a price. Several keepers can run with distinct keys. **Open:** managed signer (KMS/HSM) instead of `KEEPER_PRIVATE_KEY`, balance and staleness alerts |
| `scripts/setup.ts` | **Done:** on mainnet it never calls `setPrice` or `setFeed`; it checks each feed (18 decimals, stream id, registered) and submits one report. It deposits only when `DEPOSIT_USDC` is set |
| `src/lib/network.ts`, `src/config.ts`, `src/lib/contracts.ts`, `src/lib/realtime.ts` | **Done:** chain, RPCs and USDC follow `VITE_NETWORK` |
| `src/hooks/useRealtimeSync.ts` | **Done:** subscribes to `AnswerUpdated` on each `StreamsFeed` directly (it emits the event itself, unlike a Chainlink proxy) and reads each feed's decimals |
| `src/hooks/useKrakenPrice.ts` | **New:** stock chart from Kraken xStocks. Check Kraken's and Coinbase's terms and rate limits for production use |
| `src/hooks/useTx.ts`, `src/components/TradePage.tsx` | **Done:** no testnet wording on mainnet (there is no faucet button in the app) |
| `src/hooks/history.ts`, `src/hooks/data.ts` | **Open:** History and claimable positions scan logs from the deploy block; replace with an indexer before volume grows |
| Production RPC | **Open:** use a paid RPC and WebSocket provider with a rate guarantee (`VITE_RPC_HTTP`, `VITE_RPC_WS`, `RPC_URL`) |

## 5. Configuration and secrets

| Variable | Testnet | Mainnet |
|---|---|---|
| `VITE_NETWORK`, `NETWORK` | `testnet` | `mainnet` |
| `VITE_RPC_HTTP`, `VITE_RPC_WS`, `RPC_URL` | Optional | A paid provider |
| `VITE_MARKET_ADDRESS`, `VITE_ORACLE_ADDRESS`, `VITE_DEPLOY_BLOCK` | Testnet deployment | Printed by the deploy script |
| `VITE_FEED_BTC` ... `VITE_FEED_AAPL` | Mock feeds | `StreamsFeed` addresses. Leave a feed unset to leave the asset out |
| `VITE_KEEPER_ADDRESS` | Keeper address | Keeper address(es), comma separated |
| `KEEPER_PRIVATE_KEY` | Raw key in `.env` | Do not use. Use a managed signer, one per keeper instance |
| `STREAMS_API_KEY`, `STREAMS_API_SECRET` | Not needed | Required by the keeper. Server-side only |

Rules:
- Variables starting with `VITE_` are bundled into the browser app. Never put a secret in one.
- Use a hardware wallet for the deployer, separate accounts for keepers, and a multisig for ownership.
- Arc pays gas in USDC. Fund the keepers and alert when a balance runs low.
- Check the USDC address against Circle's documentation and the explorer before deploying. The deploy script also requires 6 decimals.

## 6. Deployment runbook

1. **Freeze.** Tag the audited commit. Record the compiler version and settings from `foundry.toml`.
2. **Rehearse on a fork.** `OWNER=<owner> bun run deploy:mainnet` simulates the full deploy against a mainnet fork and cannot broadcast. This has been done: it succeeded with about 13.7M gas (about 0.55 USDC at 20 gwei). Also run `bun run test:fork`, which deploys `StreamsFeed` against the real verifier.
3. **Deploy.** Run `NETWORK=mainnet forge script contracts/script/DeployPhinary.s.sol --fork-url arc --broadcast --sender $OWNER --account <keystore>`. It checks the chain id, USDC decimals, verifier code and a zero fee manager, then deploys the adapter, the market and one `StreamsFeed` per asset, and registers each feed (maxStaleness 600 s and the volatility bounds in section 13). `ASSETS=0,1,2` leaves the stocks out.
4. **Set `.env`** from the printed `VITE_*` lines and `NETWORK=mainnet`.
5. **Check the feeds.** With `STREAMS_API_KEY/SECRET` set, run `NETWORK=mainnet bun run setup`. It submits one report per feed. Compare each price with Coinbase or Kraken to confirm the decimals (section 3, item 1).
6. **Verify the contracts** on the explorer with source and constructor arguments.
7. **Hand over ownership.** `transferOwnership(multisig)` on every contract (adapter, market), accepted from the multisig. Check `owner()` on each.
8. **Fund.** Seed the vault from the treasury (`DEPOSIT_USDC` or directly), and fund the keepers' gas.
9. **Start the keepers** with the Streams credentials, and smoke test with tiny amounts: open a market, buy, sell back, settle, claim, set and trigger a stop order, deposit and withdraw after the lock.
10. **Publish.** Record the addresses and deploy the frontend with `VITE_NETWORK=mainnet`.

## 7. Post-deployment verification

- [ ] `owner()` on the adapter and the market returns the multisig, and the deployer holds no roles.
- [ ] For each feed: `feedId()`, `decimals()`, `verifierProxy()`, `maxReportAge()` (5), `SETTLE_WINDOW()` (10), `DISPUTE_PERIOD()` (300) and a fresh `latestRoundData()` match expectations, and the price matches the market.
- [ ] The market's `usdc()` returns the USDC address from Circle's documentation.
- [ ] Parameters read back correctly: edge, durations, strike band, staleness limits, caps.
- [ ] The smoke test passed end to end, including settlement by the keeper and by a second, independent caller.
- [ ] The explorer shows verified source for every contract.
- [ ] The frontend points at the mainnet addresses and shows no testnet wording.

## 8. Staged rollout

| Stage | Who | Limits | Move on when |
|---|---|---|---|
| 0. Private | Team and allowlist | Tiny deposit cap, tiny per-market exposure, crypto only | A full week with no unexplained mismatch, no stale-oracle incident, and keeper uptime at target |
| 1. Public, small | Everyone eligible | Small caps, crypto only | Two weeks of clean operation and realized edge in line with the model |
| 2. Raise caps | Everyone eligible | Increase caps in steps, one at a time | Each step holds for at least a week with no incident |
| 3. Stocks | Eligible users in cleared jurisdictions | Only after legal sign-off for single-stock binaries | Separate review |

Have a pause-ready person on call during stages 0 and 1.

## 9. Operations and monitoring (open)

| Signal | Alert when |
|---|---|
| Latest round age, per feed | Above 60 s (the keeper relays every 45 s or on a 2 bps move) |
| Data Streams API errors or 401s | Any |
| Vault balance versus `totalLocked + unclaimedPayouts` | Solvency ratio drops below a set margin |
| Markets past expiry and not settled | Any market more than 2 minutes late |
| Keeper gas balance | Below a day of expected spend |
| Keeper last successful action | Older than a few minutes |
| RPC errors and WebSocket reconnects | Rising rate |
| Failed transactions | Rising rate |
| Deposits and exposure versus caps | Above 80% of a cap |
| Realized profit and loss versus the model | Persistent gap |
| Any single large position or large deposit next to one | Above a set size |
| VerifierProxy fee manager | Becomes non-zero |

Send alerts to at least two people and test the routing.

## 10. Incident runbook

- **Stale or wrong oracle price.** Pause. `pause()` blocks market creation, buying and deposits. Selling back, claiming, withdrawing, settling and voiding keep working. If markets cannot be settled fairly, let them void; `voidMarket` is permissionless after the 24-hour delay.
- **Keeper down.** Report relay, settlement and order execution are permissionless, so a backup keeper (`KEEPER_INDEX` > 0, it steps in automatically) or any user can call them. Restore the primary and check the backlog.
- **Verifier fee manager set.** `submit` starts reverting `FeesNotSupported`. Pause, deploy new feeds that pay fees, and re-register them with `setFeed` (this resets their volatility history).
- **Compromised key.** Pause, rotate all roles from the multisig, review recent transactions, and tell users what happened and what is safe.
- **Contract bug.** Pause, keep exits open, publish what you know, and prepare a fix and a new audit before reopening. A redeploy needs a migration plan for open positions and LP shares.
- Keep a short written template for user communication ready before launch.

## 11. Frontend release checklist

- [ ] Production domain, HTTPS and a content security policy.
- [ ] A WalletConnect project ID for the production domain.
- [ ] Error monitoring and basic analytics, with a privacy notice.
- [ ] Risk warnings and terms where legal advice requires them; geo-blocking if required.
- [ ] Oracle age and the settlement price shown near the bet button.
- [x] No faucet button and no testnet wording on mainnet (`isTestnet`).
- [ ] Gravatar avatars send a hash of each wallet address to a third party. Keep, change or remove after a privacy review.
- [ ] Terms of use for the Coinbase and Kraken chart feeds checked.

## 12. Known limitations of the current build

- The live testnet deployment is an older build than the source (no min-output vault parameters, EWMA or oracle-age guard); redeploy testnet before relying on it.
- `StreamsFeed` has not seen a real signed report, and the price scale of each stream is assumed.
- Latency arbitrage: a trader who sees a move before it lands on chain can submit that report (at most `maxReportAge`, 5 s, old) and trade on it in one transaction. The full fix is two-step, delayed execution.
- Deposits at HIGH NAV can be diluted by an incumbent LP with a large position; LP withdrawals are priced conservatively while markets are open.
- No deposit, exposure or position caps.
- A single owner key; no role split, no timelock.
- There is no emergency early void; voiding needs 24 hours.
- A tie at the strike resolves as DOWN.
- Quotes in the browser use floating-point math, so they can differ slightly from the contract.
- History and claimable positions are read by scanning logs from the deploy block, which will not scale.
- Off-hours stock prices on the chart are tokenized-stock quotes from Kraken, not exchange prices. Check how Chainlink's 24/7 equity streams price off-hours before launching stock markets.
- The contracts have had an automated review only. They have not had an independent audit.

## 13. Current parameters (review every one)

| Parameter | Value now |
|---|---|
| House edge | 2% of the payout (allowed 1% to 5%) |
| Fair price clamp | 0.02 to 0.98 |
| Buy price limit | Reverts at 0.99 or above |
| Sell price floor | 0.01 |
| Trading closes before expiry | 15 seconds |
| Oracle age limit near expiry | Oracle age x 4 must not exceed the time left |
| Market lengths | 5, 15 and 60 minutes |
| Strike band | Within 10% of the oracle price |
| Void delay | 24 hours |
| LP deposit lock | 1 hour |
| Residual LP shares while exposed | 1e9 share units (one display share) |
| Trade staleness limit | 120 seconds (allowed range 10 to 86,400) |
| Feed staleness (`maxStaleness`) | 600 seconds |
| Report age limit (`maxReportAge`, mainnet) | 5 seconds (trading rounds only) |
| Settlement report (mainnet) | Earliest observed in [expiry, expiry + 10 s]; replaceable by an earlier one (same second: smaller report hash) for 300 s, then final |
| Position reserve | Larger side plus 99% of the smaller side, or the void refund if larger |
| Volatility bounds (min / max / default) | BTC 0.30 / 1.5 / 0.55; ETH 0.40 / 2.0 / 0.75; SOL 0.50 / 2.5 / 0.95; NVDA 0.25 / 1.5 / 0.50; AAPL 0.15 / 1.0 / 0.30 |
| Volatility model | EWMA, decay 0.94 per 60 s, observations at least 60 s apart, only on a new feed round |
| Keeper relay | 45 s heartbeat or a 2 bps move; every change in the last 255 s; whenever the oracle age rule would break before the next push; a report is relayed only if it is within `maxReportAge` on inclusion |
