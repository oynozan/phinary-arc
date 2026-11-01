## Implementation Plan: Stock Markets (NVDA, AAPL)

### Research verdict
Yes, this is possible, and 24/7 pricing now exists for exactly these two stocks. It carries heavier legal requirements than crypto, and it has real price-quality risks outside US trading hours that the design below handles instead of avoiding.

What the research found (public pages, November 2026; confirm each against Chainlink's and Circle's own documentation):
- **Chainlink 24/7 covers NVDA and AAPL.** Announced on 29 October 2026, it joins session prices into one continuous series. During regular, extended and overnight sessions it uses Chainlink's 24/5 session data. When the traditional market is closed (weekends, holidays), it uses quotes from several perpetual-futures venues. NVDA/USD and AAPL/USD each have a 24/7 Data Streams feed published as a time-weighted average price (TWAP). Chainlink names short-duration prediction markets as a use case and suggests the TWAP as the reference for deciding outcomes. It says 24/7 is delivered through both Data Streams and Data Feeds. I could not confirm which of the two exist on Arc mainnet.
- **What 24/7 means for risk.** Off-hours prices reflect trading in derivatives linked to the stock. They are not a live quote from the closed exchange. Quality differs by session: regular hours are best, overnight and weekend are weaker. Price gaps at session changes, especially the Monday open, are expected.
- **The tokenized stock is your decision.** The same price can come from different places. Options: (1) the Chainlink 24/7 reference above; (2) prices of tokenized stocks themselves (on Arc these include Dinari dShares, Backed xStocks, and custodial wrappers such as Astock's aNVDA/aAAPL and long.supply's NVDA), which trade around the clock but are third-party, custodial and thinly traded; or (3) a blend with a deviation check between them. The plan below works with any of these. The open decisions at the end ask which role you want the tokenized stock to play.
- **Delivery.** If the 24/7 push feeds are on Arc, the simpler Data Feeds path may cover longer markets. Short markets need Data Streams, the same signed-report design as "option B" in `MAINNET_MIGRATION.md`: each trade and settlement carries a report that the contract verifies.
- **Not testable on Arc testnet here.** Equity streams are unlikely to exist on testnet, so testnet work uses a simulated stream and verifier with the same report shape.
- **Fallbacks** (Pyth, Stork) cover some equities and would need a thin adapter. They need separate research before any commitment.

### Summary
Add NVDA and AAPL "above or below the strike at the deadline" markets that run 24/7 like the crypto markets and settle in USDC on a verified Chainlink 24/7 price (TWAP). Odds and risk limits adapt to the trading session, and markets void safely on halts and corporate actions.

### Architecture
- **Blockchain:** Arc Testnet for all building here. Mainnet follows the migration guide.
- **Oracle:** a new `StreamsOracle` contract replaces the feed adapter for stock assets. It verifies a signed Chainlink report, decodes the price, the session label and the timestamps, and rejects stale reports. The reference is the 24/7 stream by default (see the open decisions for the tokenized-stock option).
- **Settlement price:** the 24/7 TWAP value in a report submitted within a short window after expiry. If no valid report arrives in the window, the market voids and refunds.
- **Time model:** calendar time, exactly as for crypto, because the market never closes.
- **Volatility by session:** the volatility updater supplies bounded values for regular, extended, overnight and weekend regimes (NVDA and AAPL sit well below the crypto defaults). Pricing uses the volatility of the current session. A market that crosses a session change, above all the weekend to Monday-open gap, adds an extra jump-variance term so the odds reflect the expected gap.
- **Risk controls instead of closing the market:**
  - A wider edge and lower exposure caps in weaker sessions (overnight and weekend).
  - A shorter maximum market length, or a required minimum, across the weekend.
  - New trades blocked when the report's session or status is unknown or the report is stale.
  - An owner-managed blackout list for earnings days, splits and other events, where creation is disabled or the edge is wider.
  - A trading halt or corporate action voids the affected markets.
  - Per-asset exposure caps.
- **Contract:** a new asset class flag (crypto or equity) in the oracle and market configuration. Asset IDs 3 and 4 for NVDA and AAPL.
- **Frontend:**
  - NVDA and AAPL tabs with icons, looking and working like the crypto tabs.
  - A small session badge ("Regular session", "Overnight", "Weekend: price from derivatives venues") with a tooltip, never a closed state.
  - The chart line comes from the same 24/7 data, relayed by a small server component that holds the Chainlink credentials. The browser must never hold them.
  - Stock-specific disclosures.
- **Keeper:** fetches reports from Chainlink, submits them with trades and settlements, opens rolling markets around the clock, and settles them.
- **Compliance:** single-stock binary options are in a heavier regulatory regime than crypto. Legal sign-off per jurisdiction is a hard prerequisite for any real-money launch. Real-time equity quotes also carry data-licensing terms for display.

### Files to Create/Modify
1. `contracts/StreamsOracle.sol`: report verification, decoding, market-status and staleness checks, per-asset class and bounds.
2. `contracts/test-support/SimulatedStreamVerifier.sol` (testnet only): produces and verifies reports in the real format, with session labels (regular, extended, overnight, weekend) and a price gap at the Monday open.
3. `contracts/PredictionMarket.sol`: asset-class rules, session-aware edge and caps, jump term across session changes, blackout list, void-on-corporate-action.
4. `contracts/lib/BlackScholesLib.sol`: accept a per-session volatility and an extra jump-variance term.
5. `contracts/test/*`: session changes, weekend and holiday gaps, halts, blackout, split void, settlement window, stale and unknown-status reports, and solvency invariants.
6. `docs/design-stocks.md`: design doc for reviewers (trust model, report handling, failure modes).
7. `scripts/keeper.ts`: around-the-clock market rolling, report fetching, settlement and void handling.
8. `server/streams-relay.ts` (or a hosted function): holds credentials, streams prices to the browser, and serves reports to the keeper.
9. `src/lib/contracts.ts`: stock asset metadata (tickers, icons, session labels).
10. `src/hooks/useStockPrice.ts`: price and session from the relay.
11. `src/components/AssetTabs.tsx`, `TradePage.tsx`, `DurationTabs.tsx`: stock tabs, session badge, market lengths allowed across weekends.
12. `src/components/PriceChart.tsx`: a subtle marker where the session changes.
13. `README.md`, `AGENTS.md`, `MAINNET_MIGRATION.md`: updated for stock assets.

### Build Sequence
1. Confirm the Data Streams report format, verifier interface and fee model from Chainlink's documentation, and write the design doc.
2. Build the simulated verifier and stream with session labels and a Monday-open gap.
3. Add the stock asset class to the oracle and market contracts, with per-session volatility and the jump term.
4. Write tests for session changes, weekend gaps, halts, blackouts, splits and settlement windows, then run the security review.
5. Deploy to testnet and seed NVDA and AAPL with the simulator.
6. Build the relay, then the keeper.
7. Update the frontend: tabs, session badge, chart markers, disclosures.
8. End-to-end test across a full simulated week, including the weekend gap, a halt and a missed settlement.
9. Update the docs, then hand over for audit and legal review.

### Done When
- [ ] NVDA and AAPL markets open, trade and settle around the clock, including across a simulated weekend, like the crypto markets.
- [ ] Odds use the volatility of the current session, and a market crossing the Monday-open gap prices in the extra jump term (shown by a test).
- [ ] The edge widens and caps tighten in weaker sessions, as configured.
- [ ] A report with an unknown status, a stale timestamp or an invalid signature is rejected.
- [ ] A market with no valid settlement report voids and refunds.
- [ ] A blackout day disables creation, and a simulated split voids open markets.
- [ ] The frontend shows live price, a session badge with a tooltip, and stock-specific disclosures.
- [ ] Chainlink credentials exist only on the server component.
- [ ] Solvency invariants hold under fuzzing for the stock assets.
- [ ] Audit and per-jurisdiction legal review are recorded as complete before any mainnet launch.

### Open decisions
- What role the tokenized stock plays: not used (price comes only from the Chainlink 24/7 reference), price taken from tokenized-stock markets on Arc, a blend of both with a deviation check, or something else you have in mind such as accepting the tokenized stock as the deposit or payout asset.
- Which settlement reference to use: the 24/7 TWAP stream (Chainlink's suggestion for short markets) or a spot-style value.
- Market lengths for stocks, and whether to restrict or surcharge markets that span a weekend.
- Whether to launch stocks before the crypto markets have run on mainnet for a while.

## Ready to build?
