## Implementation Plan: Phinary Arc (BTC/ETH/SOL Binary Prediction Markets)

### Summary
A fully onchain binary prediction market for BTC, ETH and SOL on Arc Testnet. A Solidity contract prices "above or below strike at deadline" with Black-Scholes and adds a house edge. Users trade UP/DOWN positions in USDC and can sell back before expiry. A shared USDC vault that anyone can fund backs all payouts, and the edge accrues to its depositors. No tokens: positions and vault shares are internal, non-transferable accounting.

Network: Arc mainnet is out of scope; this targets Arc Testnet (chain 5042002) with faucet USDC. Moving to mainnet later only requires different oracle addresses and RPC.

### Architecture
- Blockchain: Arc Testnet. USDC is the gas token. Contracts use only the 6-decimal ERC-20 USDC at 0x3600000000000000000000000000000000000000 and never msg.value.
- Oracle: PriceOracleAdapter wraps one Chainlink AggregatorV3Interface feed per asset, with a staleness check and normalization to 1e18. Chainlink Data Feeds were not confirmed live on Arc Testnet, so the deploy uses a MockAggregator (full AggregatorV3 incl. getRoundData) updated by a keeper from public spot prices. Swapping to real feeds = setFeed(asset, address), no other contract change. UI labels the mock as a testnet price source.
- Volatility (realized, onchain): adapter keeps a ring buffer of the last 32 observations per asset, appended by poke(asset) (rate-limited to once per 60s) and on every trade. Sigma = annualized RMS of log returns, clamped to owner-set per-asset [minVol, maxVol]. Default vol until at least 8 samples exist.
- Pricing (BlackScholesLib): fixed-point 1e18 ln, exp, sqrt and normal CDF. Fair UP = Phi((ln(S/K) - 0.5*sigma^2*T) / (sigma*sqrt(T))), r = 0. DOWN = 1 - UP. Buy price = fair + edge; sell price = fair - edge. Edge is configurable (default 2% of the 1 USDC payout, owner-adjustable up to a cap). Prices clamped to [0.02, 0.98]. Trading closes 15s before expiry.
- Market contract (PredictionMarket): each unit pays 1 USDC (1e6) if it wins.
  - createMarket(asset, strike, expiry): permissionless; expiry from allowed durations (5m, 15m, 1h); strike within +/-10% of spot.
  - buy(marketId, isUp, units, maxCost) and sell(marketId, isUp, units, minProceeds).
  - settle(marketId, roundId): permissionless; roundId must be the first round with updatedAt >= expiry (previous round updatedAt < expiry), so callers cannot pick a favorable price.
  - claim(marketId) pays winners. Strike == settlement price resolves DOWN (documented in UI).
  - voidMarket(marketId) if unsettled after 24h: refunds each user's cost basis.
  - Events: Bought(marketId, user, isUp, units, cost, fairPrice, oraclePrice, timestamp) and Sold(...) so the UI can plot bets on the chart from logs.
  - Stop loss / take profit on the UNDERLYING price (stored onchain, executed by the keeper):
    - setOrder(marketId, isUp, stopPrice, takeProfitPrice): 0 means "none". Validated against current oracle spot: UP needs stop < spot < take profit; DOWN needs take profit < spot < stop. Applies to the user's whole position in that market and side.
    - executeOrder(marketId, user, isUp): permissionless. Reverts unless the ORACLE price has crossed a trigger (UP: price <= stop or >= take profit; DOWN: price >= stop or <= take profit) and trading is still open. It sells all remaining units at the normal sell price (fair - edge) and pays the user. Anyone can call it, so the keeper is not a trust point.
    - cancelOrder(marketId, isUp); orders are also cleared when the position is fully sold or the market settles/voids. Events: OrderSet, OrderCancelled, OrderExecuted.
    - Triggers use the oracle price (the same source as settlement), not the Coinbase chart line. The chart labels both.
- Vault (PredictionVault, same contract or sibling): deposit(amount) / withdraw(shares) with non-transferable internal shares. Worst-case exposure per market = max(upUnits, downUnits); a trade reverts if total worst-case exposure across open markets exceeds vault USDC. Share price = (USDC balance - unclaimed settled payouts) / total shares. Withdrawals capped to free liquidity and subject to a 1-hour minimum deposit lock. Open-market risk is not marked-to-model in share price (known limitation; flag for security review).
- Frontend: React + Tailwind + wagmi/viem + framer-motion. Trade page (BTC/ETH/SOL tabs, live price chart, market list with UP/DOWN odds, countdown, buy/sell panel with quote and optional SL/TP, create-market form), Vault page (shares, TVL, exposure, deposit/withdraw), Positions (open positions with their SL/TP, sell, cancel order, claim). Odds from a quote() view function.
- Live chart (shadcn chart component on Recharts; add `recharts` and the shadcn `chart.tsx` + `cn` helper by hand):
  - Price line: Coinbase public data. REST candles backfill the window, then the WebSocket ticker streams BTC-USD / ETH-USD / SOL-USD. If the stream drops, the chart falls back to the oracle line and shows an "oracle only" badge. Settlement and SL/TP always use the oracle.
  - Overlays for the selected market: dashed strike line, an oracle-price marker, and a vertical deadline line labelled with the date/time and a live countdown. The x-axis extends to the deadline so the line runs toward it. I read "show deadline with a Y axis" as this vertical deadline line and "SL/TP with X axes" as horizontal price lines; tell me if you meant something different.
  - Your SL (fail red) and TP (success green) appear as labelled horizontal lines when you hold a position with orders; they animate in when set and are edited from the order form.
  - Bettor avatars: every Bought event for the market becomes an avatar pinned to the line at the bet's timestamp, ringed green for UP and red for DOWN, with a tooltip (short address, side, units, cost). New bets pop in with a spring animation; the latest ~50 are shown.
- Avatars: address-based Gravatar identicons only, no email linking. URL = https://gravatar.com/avatar/<sha256 of the lowercase address>?d=identicon&f=y&s=64 (hash via viem). Gravatar sees wallet addresses, which are already public onchain.
- Design system (your direction overrides the studio defaults):
  - Colors: main #1083FF (CTAs, price line, active states), white text, success #97CB3D (UP, wins, TP, positive PnL), fail #F44708 (DOWN, losses, SL, errors). Canvas is a deep navy derived from the main blue with slightly lighter card surfaces so white text stays readable; no other accent colors. White on #1083FF/#F44708 is only used for semibold text at 16px or larger.
  - Fonts: Akt (Google Fonts, variable weight 100-900, OFL) for headings, UI and body; Manrope for numbers, prices, odds and small labels (with tabular-nums). Loaded via Google Fonts links in index.html; if the Akt stylesheet doesn't resolve, the build bundles Akt[wght].ttf from google/fonts (ofl/akt) into public/fonts with @font-face.
  - Feasy-style feel (I couldn't load feasy.org, so this is my reading of "blobby"): large rounded cards and pill buttons, soft animated blue blobs in the background, spring transitions, skeleton loaders for every chart, odds and balance while data loads, and the countdown/odds changing with rolling numbers. Reduced-motion is respected.
- Wallet: ConnectKit on Arc Testnet, faucet link for USDC.
- Keeper: scripts/keeper.ts (bun) pushes mock feed prices (from Coinbase spot), pokes vol buffer, opens rolling ATM markets, settles expired ones, and each tick checks open SL/TP orders (read from OrderSet logs) against the oracle price and calls executeOrder when a trigger is crossed. Key read from .env, never exposed to the browser. The keeper pays gas in testnet USDC; anyone else can also call executeOrder.

### Files to Create/Modify
1. contracts/interfaces/AggregatorV3Interface.sol - Chainlink feed interface.
2. contracts/MockAggregator.sol - testnet feed with round history and owner-only setPrice.
3. contracts/PriceOracleAdapter.sol - feed registry, staleness, 1e18 normalization, observation ring buffer, realized vol.
4. contracts/lib/BlackScholesLib.sol - ln, exp, sqrt, normal CDF, binary price.
5. contracts/PredictionMarket.sol - markets, buy/sell, settle, claim, void, SL/TP orders (set/cancel/execute), edge/params, vault accounting, events (split to PredictionVault.sol if large).
6. contracts/test/BlackScholesLib.t.sol - reference values, monotonicity in S, T, sigma.
7. contracts/test/PredictionMarket.t.sol - lifecycle, exposure caps, void path, vault share math, settlement-round validation, SL/TP validation and execution (both sides), orders cleared on full sell/settle.
8. contracts/script/DeployPhinaryArc.s.sol - deploys mocks, adapter, market; wires three assets.
9. scripts/keeper.ts - price push, oracle poke, market rotation, settlement, SL/TP order execution.
10. src/config.ts - add deployed addresses and chain config (existing file).
11. src/lib/contracts.ts - ABIs and typed addresses.
12. src/lib/format.ts - USDC, price, odds formatting (uses @/onchain-money).
13. src/App.tsx - layout, routing between Trade / Vault / Positions, connect button, animated blob background (replace starter stub).
14. index.html - Google Fonts links for Akt (wght 100..900) and Manrope; page title.
15. tailwind.config.js - palette (main #1083FF, success #97CB3D, fail #F44708, white text, navy surfaces), fontFamily (Akt primary, Manrope secondary), large radii.
16. src/index.css - CSS variables, base text styles, blob keyframes, skeleton shimmer, reduced-motion rules (plus @font-face fallback with the font in public/fonts/ if Akt must be bundled).
17. src/lib/utils.ts - cn() helper (clsx + tailwind-merge).
18. src/components/ui/chart.tsx - shadcn chart primitives (ChartContainer, ChartTooltip) over Recharts; add the recharts dependency.
19. src/components/ui/skeleton.tsx - blobby skeleton loader used for chart, odds, balances.
20. src/components/PriceChart.tsx - live line chart with strike, oracle marker, deadline vertical line, SL/TP lines and bettor avatars.
21. src/components/BettorAvatar.tsx and src/lib/gravatar.ts - sha256 of address -> Gravatar identicon URL, ringed by side.
22. src/hooks/useCoinbasePrice.ts - REST candle backfill + WebSocket ticker with reconnect and oracle fallback.
23. src/hooks/useMarketBets.ts - Bought/Sold logs (history + live watch) for the selected market.
24. src/hooks/useOrders.ts - the user's SL/TP orders from OrderSet/OrderExecuted/OrderCancelled logs.
25. src/components/AssetTabs.tsx - BTC/ETH/SOL selector with live price.
26. src/components/MarketCard.tsx - strike, countdown, UP/DOWN odds, trade button.
27. src/components/TradePanel.tsx - buy/sell with quote, slippage, approval flow, optional SL/TP inputs (underlying price levels, validated like the contract), tx states.
28. src/components/CreateMarket.tsx - strike and duration form with band validation.
29. src/components/VaultPanel.tsx - deposit/withdraw, share price, TVL, exposure.
30. src/components/PositionsList.tsx - open positions with SL/TP, sell, edit/cancel order, claim.
31. src/hooks/useMarkets.ts, src/hooks/useQuote.ts - batched reads and polling.
32. AGENTS.md - update app description, addresses, keeper instructions, design tokens.

### Build Sequence
1. Write AggregatorV3Interface, MockAggregator, PriceOracleAdapter and BlackScholesLib; compile and unit-test the math against reference values.
2. Write PredictionMarket (and vault); add lifecycle and exposure tests; fix failures.
3. Safety review of contracts: vault accounting, settlement round selection, rounding direction (always favor the vault), withdrawal cap.
4. Deploy mock feeds, adapter and market to Arc Testnet; record addresses in src/config.ts; seed mock prices and vault with faucet USDC.
5. Set up the design foundation: fonts, palette tokens, blob background, skeleton loader, shadcn chart primitives.
6. Build the frontend: asset tabs and market list, then the live chart (Coinbase line, strike, oracle marker, deadline, bettor avatars), then trade panel with quotes and SL/TP, then vault and positions views.
7. Write and run scripts/keeper.ts to open and settle markets and execute SL/TP orders; verify a full buy -> avatar appears -> set SL/TP -> trigger sells -> (or expiry -> claim) cycle in the preview.
8. Update AGENTS.md and document how to swap the mock for real Chainlink feeds.

### Done When
- [ ] Contracts compile and all unit tests pass, including Black-Scholes reference values.
- [ ] Market and oracle contracts are deployed on Arc Testnet and addresses are in src/config.ts.
- [ ] BTC, ETH and SOL each show a live price and at least one open market with UP/DOWN odds that move with price and time.
- [ ] Buy price > fair price and sell price < fair price; the edge is visible in the quote.
- [ ] A connected wallet can buy, sell back before expiry, and claim after settlement.
- [ ] Anyone can deposit into and withdraw from the vault; share price rises after the vault wins trades.
- [ ] Trades are rejected when they would exceed vault capacity, and a stale oracle price blocks trading.
- [ ] The keeper opens, pokes and settles markets without manual steps.
- [ ] The UI flags the mock oracle as a testnet price source.
- [ ] The chart streams a live Coinbase line with skeleton loading, shows the strike, oracle marker and a deadline line with date and countdown, and falls back to oracle-only if the stream drops.
- [ ] Placing a bet makes that wallet's Gravatar identicon appear on the line at the bet time (green ring UP, red ring DOWN); other bettors' avatars appear too.
- [ ] Setting SL/TP on a position draws red/green horizontal lines on the chart; when the oracle price crosses a level, the keeper sells the position without the user's browser open, and the position list updates.
- [ ] Invalid SL/TP levels (wrong side of spot) are rejected in the UI and the contract.
- [ ] The UI uses only the specified palette (#1083FF, white, #97CB3D, #F44708 plus navy surfaces), Akt for UI text and Manrope for numbers/labels.

## Ready to build?
