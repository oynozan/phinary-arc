## Mainnet Readiness Plan: Phinary Arc

### Summary
Arc Studio only builds and deploys on Arc Testnet, so the mainnet launch itself (deploying, funding, running production services) has to be done by your team outside Arc Studio. This plan has two parts. Part A is the work that can be built and tested here on testnet now. Part B is the work that must happen outside this workspace before and during a mainnet launch. Nothing here has been deployed to mainnet.

Facts checked from public sources (confirm each against Chainlink's own directory before relying on it):
- Arc mainnet went live in September 2026, and Chainlink lists Data Feeds and Data Streams as available on Arc mainnet.
- The BTC/USD, ETH/USD and SOL/USD feeds there are push feeds with a 0.5% deviation threshold and a heartbeat measured in hours, not seconds.
- A third-party check found no Chainlink Data Feeds on Arc testnet, so real feeds cannot be tested on testnet here.

### Architecture (what must change)
- **Oracle:** remove `MockAggregator` and the keeper's price-pushing. The oracle adapter reads real Chainlink proxy addresses, verified at deploy time by `description()`, `decimals()` and a fresh `latestRoundData()`.
- **Market length (the biggest decision):** a feed that updates only on a 0.5% move or an hourly heartbeat is far coarser than a 5-minute market's typical price move (about 0.15%). Anyone watching live exchange prices could buy the favorable side before the feed updates, and the 2% edge does not cover that. Two options:
  - **Option 1, Data Feeds only (smallest change):** drop the 5-minute and 15-minute markets and offer 1-hour, 4-hour and 24-hour markets. Widen the edge as the feed ages, and reject trades when the feed is older than a limit set from its documented heartbeat plus a margin.
  - **Option 2, Data Streams (keeps short markets):** the trader or keeper submits a signed Chainlink report with each trade and each settlement, and the contract verifies it through the Data Streams verifier. This needs a contract rewrite for pricing and settlement, Chainlink Streams access, a server-side relay for the credentials, and fee handling for report verification.
  - Recommendation: start with Option 1. Treat Option 2 as a later phase.
- **Settlement rule:** "first oracle round at or after expiry" is wrong for sparse feeds, because that round can be hours late and reflect a later price. Change it to "the round that was current at expiry", meaning the last round with `updatedAt <= expiry` provided the next round is after expiry. Reject the round if it is older than the feed's heartbeat plus margin, and keep the void-and-refund path for failures.
- **Volatility:** the on-chain ring buffer samples a feed that only changes on 0.5% moves, which produces unreliable realized volatility. Replace it with a bounded, rate-limited volatility value pushed by an authorized updater role. The updater computes it off-chain from exchange data, and the contract clamps it to a minimum and maximum and caps the change per update.
- **Vault and LP safety:**
  - Replace the conservative-withdrawal workaround with a proper design: mark-to-model valuation or settlement-epoch withdrawals.
  - Add hard limits on total exposure, per-market exposure and per-user position size.
  - Scale limits to vault size.
- **Governance:** the owner becomes a multisig behind a timelock. Edge changes, volatility bounds, feed changes and pausing each get explicit roles. There is no renounce, and no function can move vault funds.
- **Gas:** a buy costs about 2.4M gas today because volatility is recomputed on every trade. Cache the volatility value, which the updater-based design above does anyway.
- **Frontend:** the price shown comes from the exchange stream, while bets settle on the oracle. With a coarse feed the gap can be large, so the settlement price and its age must be prominent. Replace the mock's `PriceSet` listener with Chainlink's aggregator events (proxy addresses do not emit them), and handle feed upgrades.

### Part A: Work that can be done here, on testnet
1. Write a contract design doc (roles, trust model, oracle assumptions, failure modes, upgrade and emergency plan) for reviewers to sign off.
2. Build a feed simulator that behaves like the real feeds: 0.5% deviation trigger, hourly heartbeat, round IDs, staleness. Run the keeper against it so the effect on short markets, stale quotes and settlement is visible before any real money is involved.
3. Rework the contracts: the settlement-round rule, the adjustable staleness limit, the age-based edge widening, the volatility updater role, the exposure caps and the vault valuation fix.
4. Extend the tests: invariants and fuzzing for solvency across every rule above, simulated price paths against the feed simulator, and adversarial tests for stale-price exploitation.
5. Rerun the security review on the changed contracts, with static analysis.
6. Frontend changes: show oracle price and age on the bet screen, render the settlement rule, remove testnet-specific wording from the build, and keep the testnet toggle behind configuration.
7. Production-grade keeper: no private key in `.env`, redundant instances, alerting, and a small tip to whoever settles or executes an order so it does not depend on one operator.
8. Replace the log-scanning history with an indexer (a subgraph or a hosted indexing service) and use a paid RPC provider with a guaranteed rate.

### Part B: Work outside Arc Studio (mainnet only)
1. **Independent audit:** commission a professional smart-contract audit of the final contracts. Fix findings and have the fixes re-reviewed. Run a bug bounty before and after launch.
2. **Legal and compliance:** binary prediction markets and options are regulated in many jurisdictions. Get legal advice on licensing, geographic restrictions, user eligibility, sanctions screening, and terms and risk disclosures before any real-money launch. This is a launch blocker, not a polish item.
3. **Feed verification:** read the proxy addresses from Chainlink's official directory for Arc mainnet, check heartbeat and deviation for each pair, and assert on `description()` in the deployment script.
4. **Fork testing:** run the full test suite against a fork of mainnet to read the real feeds, then rehearse the deploy on that fork.
5. **Deployment:** deploy from a hardware-backed wallet, verify the contracts on the block explorer, transfer ownership to the multisig and timelock, and publish the addresses.
6. **Staged rollout:** launch with a tiny deposit cap and per-market exposure caps, only 1-hour and longer markets, and a pause-ready team on call. Raise the caps in steps as real behavior matches the simulations.
7. **Operations:** monitoring for keeper health, oracle staleness, vault balance versus reserves and settlement lag. Write an incident runbook (pause, void, communicate) and rehearse it.
8. **Frontend release:** production domain, WalletConnect project ID, error monitoring, content security policy, geo-blocking if legal requires it, and a plan for the exchange price stream's rate limits and terms.

### Files to Create/Modify
1. `contracts/PriceOracleAdapter.sol`: real-feed checks, staleness from heartbeat, volatility updater role, new settlement-round rule.
2. `contracts/PredictionMarket.sol`: exposure caps, age-based edge, vault valuation fix, role split, governance hooks.
3. `contracts/test/*`: invariant, fuzz, simulator-driven and adversarial tests for the above.
4. `contracts/SimulatedChainlinkFeed.sol` (testnet only): feed simulator with deviation, heartbeat and round IDs.
5. `docs/design.md`: the contract design doc.
6. `scripts/keeper.ts`, `scripts/setup.ts`: remove price pushing, add volatility updates, tips and monitoring hooks.
7. `src/hooks/useRealtimeSync.ts`, `src/hooks/data.ts`: replace the mock's price event with aggregator events and add oracle age.
8. `src/components/TradePage.tsx`, `BuyForm.tsx`, `DurationTabs.tsx`: market-length options, oracle age and settlement price on the bet screen.
9. `src/lib/contracts.ts`: configuration-driven network and feed addresses.

### Build Sequence
1. Decide the open product questions below.
2. Write the design doc and get it reviewed.
3. Build the feed simulator and run the current system against it to measure the exposure.
4. Rework the oracle adapter and settlement rule, then the vault and market changes.
5. Write the new tests and fix what they find.
6. Run the security review, then redeploy to testnet and soak-test with the simulator.
7. Update the keeper and frontend, then run a full end-to-end pass on testnet.
8. Hand the repository to your team for Part B.

### Done When
- [ ] No mock contract is referenced by the production configuration, and the keeper does not push prices.
- [ ] The adapter refuses any feed whose description or decimals do not match, or whose latest round is stale.
- [ ] Settlement uses the round current at expiry, with a tested void path when no valid round exists.
- [ ] Simulated stale-price exploitation cannot extract more than the configured edge and caps allow.
- [ ] Solvency invariants hold under fuzzing across trades, sell-backs, settlement, voids and LP flows.
- [ ] An independent audit is complete with all high and medium findings fixed.
- [ ] Legal sign-off is recorded for the target launch jurisdictions.
- [ ] Ownership sits with a multisig and timelock, and the pause and void runbooks have been rehearsed.
- [ ] A staged rollout plan with deposit and exposure caps is approved.

### Open decisions
- Short markets (needs Data Streams) or hour-and-longer markets (Data Feeds only) for launch.
- Who may deposit as an LP at launch (open to anyone, or an allowlist at first).
- Which jurisdictions are in scope for launch.

## Ready to build?
