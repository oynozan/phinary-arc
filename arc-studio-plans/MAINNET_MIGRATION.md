# Mainnet migration guide: Phinary Arc

Status: guidance for your team. Nothing in this repository has been deployed to, or configured for, Arc mainnet. Arc Studio builds and deploys on Arc Testnet only, so everything below is done by you, outside Arc Studio.

The current build is a testnet build. It uses a mock price feed, a single keeper wallet that owns every contract, and contracts that have had an automated review and tests but no independent audit. It must not hold real funds as it stands.

Facts about Arc mainnet and Chainlink in this guide come from public pages read in November 2026. Re-check each one in Chainlink's and Circle's official documentation before relying on it. Feed addresses, heartbeats and fees change.

---

## 1. Go / no-go gates

Do not deploy to mainnet until every box is ticked.

- [ ] Independent smart-contract audit of the final contracts is complete; all high and medium findings are fixed and re-reviewed.
- [ ] Legal advice received for each launch jurisdiction (binary prediction markets and options are regulated in many places).
- [ ] The oracle strategy is decided (section 2) and implemented, with no mock contract in the production configuration.
- [ ] The contract owner is a multisig behind a timelock, not a single key.
- [ ] A deposit cap and per-market exposure caps are set and tested.
- [ ] Monitoring, alerting and an incident runbook exist and have been rehearsed on testnet.
- [ ] A rollout plan with small caps is approved (section 8).

## 2. Decisions to make first

### 2.1 Oracle and market length (the most important decision)
Chainlink Data Feeds on Arc mainnet are push feeds. The BTC, ETH and SOL feeds update when the price moves by about 0.5% or when the heartbeat (hours) expires. That is far coarser than a 5-minute market, where a normal price move is about 0.15%. Anyone watching live exchange prices can buy the favourable side before the feed catches up, and the 2% edge does not cover it.

| Option | What you launch | Contract work |
|---|---|---|
| A. Data Feeds only (recommended first) | 1-hour, 4-hour and 24-hour markets | Moderate: new settlement rule, staleness limits, age-based edge |
| B. Data Streams | Short markets (5 and 15 minutes) | Large: trades and settlements carry a signed report that the contract verifies through the Streams verifier. Needs Chainlink access, a server-side relay for credentials, and report fees |

Confirm the exact heartbeat and deviation for each pair on Chainlink's Arc price feed page before choosing durations.

### 2.2 Other decisions
- Who can deposit as a liquidity provider at launch: anyone, or an allowlist.
- Which jurisdictions are in scope, and whether you geo-block the others.
- The house edge, and how it widens as the oracle price ages.
- Which assets launch. The stock-market extension is described in `arc-studio-plans/tokenized-stocks.md`.

## 3. Contract changes required before deployment

Make these on testnet, re-test, and have the final version audited.

1. **Remove the mock feed from production.** `contracts/MockAggregator.sol` is testnet-only. Production wiring calls `PriceOracleAdapter.setFeed(assetId, feedProxy, maxStaleness, minVol, maxVol, defaultVol)` with the real Chainlink proxy for each pair. Before calling it, read the proxy and check that `description()` matches the pair (for example "BTC / USD"), that `decimals()` is what you expect, and that `latestRoundData()` returns a positive answer updated within the heartbeat.
2. **Settlement rule.** Today `settlementPrice` accepts the first round at or after expiry. On a feed that updates rarely, that round can arrive hours late and reflect a later price. Change it to the round that was current at expiry (the last round with `updatedAt <= expiry`, where the next round is after expiry). Reject it if it is older than heartbeat plus margin, and keep the 24-hour void-and-refund path for failures.
3. **Staleness.** `maxTradeStaleness` defaults to 120 seconds, which suits the mock. Set each feed's `maxStaleness` and the trade limit from the documented heartbeat plus a margin (commonly 10 to 25%), and widen the edge as the price ages.
4. **Volatility.** The on-chain ring buffer samples the feed, which only changes on large moves, so realized volatility is unreliable. Replace it with a bounded value pushed by an authorized updater role: clamp to [minVol, maxVol] and cap the change per update.
5. **Vault valuation and caps.** Withdrawals are priced conservatively while markets are open. Decide on a final design (mark-to-model or settlement epochs). Add a total-deposit cap, a per-market exposure cap and a per-user position cap.
6. **Governance.** Replace the single owner with distinct roles (parameters, pausing, feed changes, volatility updates). Ownership of every contract moves to a multisig and timelock using the two-step transfer already in the contracts. Renouncing ownership is intentionally disabled.
7. **Gas.** A buy uses about 2.4 million gas because volatility is recomputed on every trade. Caching the volatility value (change 4) removes most of it. Re-measure on the final code.
8. **Keeper incentive.** Today the operator pays gas to settle markets and execute orders. Add a small tip so any party can run a keeper. The functions are already permissionless.

## 4. Repository changes

| File | Change |
|---|---|
| `contracts/PriceOracleAdapter.sol` | New settlement rule, staleness from heartbeat, volatility updater role (section 3) |
| `contracts/PredictionMarket.sol` | Caps, age-based edge, role split, cached volatility |
| `contracts/MockAggregator.sol` | Keep for testnet only. Never deploy it to mainnet. Consider moving it to a `test-support` folder |
| `contracts/test/*` | Update for the new rules; add invariant and fuzz tests, and tests against a simulated Chainlink-style feed (0.5% deviation, hourly heartbeat, round IDs) |
| `scripts/setup.ts` | Today it seeds mock prices and deposits keeper funds. For mainnet write a separate wiring script that reads the real feed addresses, asserts `description()`, `decimals()` and freshness, then calls `setFeed`. It must not call `setPrice` and must not deposit funds |
| `scripts/keeper.ts` | Remove the price-pushing loop and the Coinbase price source for the oracle. Keep market rotation, settlement and order execution. Adapt round selection to the new settlement rule. Add volatility updates, balance and staleness alerts, and run at least two instances. Replace `KEEPER_PRIVATE_KEY` in `.env` with a managed signer (KMS or HSM) |
| `src/hooks/useRealtimeSync.ts` | It listens to the mock's `PriceSet` event. Chainlink proxies do not emit events; the underlying aggregator emits `AnswerUpdated`. Read the proxy's `aggregator()` address, subscribe to that, and re-resolve it when the feed's aggregator changes |
| `src/hooks/data.ts`, `src/components/TradePage.tsx` | Show oracle age next to the settlement price, and handle a stale oracle clearly |
| `src/lib/contracts.ts`, `.env` | Chain, contract and feed addresses (section 5) |
| `src/lib/realtime.ts` | Use a paid RPC and WebSocket provider with a rate guarantee. The public endpoint allows only about 20 requests in flight, which is why reads are queued 8 at a time |
| `src/hooks/useCoinbasePrice.ts` | Check the exchange's terms and rate limits for production use; add a fallback source |
| `src/components/Header.tsx` and others | Remove testnet wording and the "Get test USDC" button; add risk disclosures and a geo-block if legal advice requires it |
| `src/hooks/history.ts` | Replace log scanning from the deploy block with an indexer (a subgraph or hosted indexing service) |
| `README.md`, `AGENTS.md` | Update to describe production |

## 5. Configuration and secrets

| Variable | Testnet today | Mainnet |
|---|---|---|
| `VITE_MARKET_ADDRESS` | Testnet market | New market address after deployment |
| `VITE_ORACLE_ADDRESS` | Testnet adapter | New adapter address |
| `VITE_FEED_BTC`, `VITE_FEED_ETH`, `VITE_FEED_SOL` | Mock feed addresses | The aggregator addresses the frontend should listen to (see the realtime row above) |
| `VITE_DEPLOY_BLOCK` | Testnet deploy block | Mainnet deploy block (or drop it when you adopt an indexer) |
| `VITE_KEEPER_ADDRESS` | Testnet keeper | Mainnet keeper account |
| `KEEPER_PRIVATE_KEY` | Raw key in `.env` | Do not use. Use a managed signer |

Rules:
- Variables starting with `VITE_` are bundled into the browser app. Never put a secret in one.
- Use a hardware wallet for the deployer, a separate account for the keeper, and a multisig for ownership.
- Arc pays gas in USDC. Fund the keeper with USDC and alert when its balance runs low.
- Take the USDC address from Circle's documentation and check it on the explorer. Do not copy it from this repository.

## 6. Deployment runbook

1. **Freeze.** Tag the audited commit. Record the compiler version and settings from `foundry.toml` so the build can be reproduced.
2. **Rehearse on a fork.** Fork mainnet locally and run the test suite and the deployment steps against it, so the real feeds are read but nothing is sent to the network.
3. **Deploy, in this order, with no mocks:**
   1. `PriceOracleAdapter(initialOwner)`.
   2. `PredictionMarket(usdc, oracle, initialOwner)`.
   Use the deployer wallet as the temporary owner.
4. **Wire the feeds.** For each pair call `setFeed` after the checks in section 3, item 1. Then set the edge, the allowed durations, the strike band, the trade staleness limit and the caps.
5. **Verify the contracts** on the block explorer with source code and constructor arguments.
6. **Hand over ownership.** Call `transferOwnership(multisig)` on each contract and accept it from the multisig (the transfer is two-step). Check `owner()` on each, then remove any deployer privileges and rotate keys.
7. **Fund.** Seed the vault with a small initial deposit from the treasury, and fund the keeper's gas.
8. **Smoke test** with tiny amounts: open a market, buy, sell back, wait for settlement, claim, set and trigger a stop order, then deposit and withdraw after the lock.
9. **Publish.** Record the addresses, set the frontend environment, and deploy the frontend.

## 7. Post-deployment verification

- [ ] `owner()` on the adapter and the market returns the multisig, and the deployer holds no roles.
- [ ] For each feed: `description()`, `decimals()` and the age of `latestRoundData()` match expectations.
- [ ] The market's `usdc()` returns the USDC address from Circle's documentation.
- [ ] Parameters read back correctly: edge, allowed durations, strike band, staleness limit, caps.
- [ ] The smoke test in section 6 passed end to end, including settlement by the keeper and by a second, independent caller.
- [ ] The explorer shows verified source for both contracts.
- [ ] The frontend points at the mainnet addresses and shows no testnet wording.

## 8. Staged rollout

| Stage | Who | Limits | Move on when |
|---|---|---|---|
| 0. Private | Team and allowlist | Tiny deposit cap, tiny per-market exposure, longest markets only | A full week with no unexplained mismatch, no stale-oracle incident, and keeper uptime at target |
| 1. Public, small | Everyone eligible | Small caps, 1-hour and longer markets | Two weeks of clean operation and realized edge in line with the model |
| 2. Raise caps | Everyone eligible | Increase caps in steps, one at a time | Each step holds for at least a week with no incident |
| 3. Short markets | Everyone eligible | Only after Data Streams is built and audited (option B) | Separate audit and rollout |

Have a pause-ready person on call during stages 0 and 1.

## 9. Operations and monitoring

| Signal | Alert when |
|---|---|
| Oracle age, per feed | Above 80% of the heartbeat |
| Vault balance versus `totalLocked + unclaimedPayouts` | Solvency ratio drops below a set margin |
| Markets past expiry and not settled | Any market more than 2 minutes late |
| Keeper gas balance | Below a day of expected spend |
| Keeper last successful action | Older than a few minutes |
| RPC errors and WebSocket reconnects | Rising rate |
| Failed transactions | Rising rate |
| Deposits and exposure versus caps | Above 80% of a cap |
| Realized profit and loss versus the model | Persistent gap |
| Any single large position | Above a set size |

Send alerts to at least two people and test the routing.

## 10. Incident runbook

- **Stale or wrong oracle price.** Pause. `pause()` blocks market creation, buying and deposits. Selling back, claiming, withdrawing, settling and voiding keep working. Investigate with Chainlink. If markets cannot be settled fairly, let them void; `voidMarket` is permissionless after the 24-hour delay.
- **Keeper down.** Settlement and order execution are permissionless, so a second keeper or any user can call them. Restore the primary and check the backlog.
- **Compromised key.** Pause, rotate all roles from the multisig, review recent transactions, and tell users what happened and what is safe.
- **Contract bug.** Pause, keep exits open, publish what you know, and prepare a fix and a new audit before reopening. A redeploy needs a migration plan for open positions and LP shares.
- Keep a short written template for user communication ready before launch.

## 11. Frontend release checklist

- [ ] Production domain, HTTPS and a content security policy.
- [ ] A WalletConnect project ID for the production domain.
- [ ] Error monitoring and basic analytics, with a privacy notice.
- [ ] Risk warnings and terms where legal advice requires them; geo-blocking if required.
- [ ] Oracle age and the settlement price shown near the bet button.
- [ ] No faucet button, no testnet labels.
- [ ] Gravatar avatars send a hash of each wallet address to a third party. Keep, change or remove after a privacy review.

## 12. Known limitations of the current build

- A mock oracle and a single keeper that owns every contract (testnet only).
- Realized volatility from the on-chain sampler is unreliable on sparse feeds.
- Settlement uses the first round after expiry.
- LP withdrawals are priced conservatively while markets are open, which penalizes people who leave early.
- There is no emergency early void; voiding needs 24 hours.
- A tie at the strike resolves as DOWN.
- Quotes in the browser use floating-point math, so they can differ slightly from the contract.
- Order history is read by scanning logs from the deploy block, which will not scale.
- A buy costs about 2.4 million gas.
- The contracts have had an automated review only. They have not had an independent audit.

## 13. Current testnet parameters (review every one)

| Parameter | Value now |
|---|---|
| House edge | 2% of the payout (hard cap 5%) |
| Fair price clamp | 0.02 to 0.98 |
| Buy price limit | Reverts at 0.99 or above |
| Sell price floor | 0.01 |
| Trading closes before expiry | 15 seconds |
| Market lengths | 5, 15 and 60 minutes |
| Strike band | Within 10% of the oracle price |
| Void delay | 24 hours |
| LP deposit lock | 1 hour |
| Trade staleness limit | 120 seconds (allowed range 10 to 86,400) |
| Position reserve | Larger side plus 99% of the smaller side |
| Volatility bounds | BTC 0.30 to 1.5 (default 0.55); ETH 0.40 to 2.0 (default 0.75); SOL 0.50 to 2.5 (default 0.95) |
| Volatility sampling | 32 observations, at least 60 seconds apart, at least 8 needed |
