# Phinary Arc

Onchain price prediction markets for BTC, ETH and SOL on Arc Testnet. Pick a strike price and a deadline, bet UP or DOWN with USDC, and sell back any time before the deadline. Odds come from a Black-Scholes model plus a small house edge, and a shared USDC vault that anyone can fund backs every payout. There are no tokens.

Built with [Arc Studio](https://studio.arc.io)

## What you can do

- Trade BTC, ETH and SOL markets (5 minute, 15 minute and 1 hour) with live odds, optionally with your own strike price.
- See your expected payout, profit, chance to win and fee before you bet. Previews are computed in the browser.
- Watch a live price chart with the strike, the deadline and every bettor's avatar on the line.
- Track open bets under the chart, close any of them with one click, and see the result the moment a market ends.
- Review every action in the History page.
- Set a stop loss and take profit on the underlying price. A keeper sells your position when the level is crossed, even if you are offline.
- Deposit into the vault to earn the house edge, and withdraw after the 1 hour lock.
- Claim winnings, or a refund if a market is voided.

## Tech stack

- React, Vite, TypeScript, Tailwind CSS, framer-motion
- wagmi, viem, ConnectKit
- Recharts (shadcn chart components)
- Solidity 0.8.28 and Foundry
- Arc Testnet, USDC, live data over WebSocket (no polling)

## Development

Prerequisites: [Bun](https://bun.sh), [Foundry](https://getfoundry.sh).

```bash
bun install
bun run dev          # app on http://localhost:5173
bun run keeper       # keeper bot: prices, markets, settlement, SL/TP orders
bun run contracts:build
bun run contracts:test
bun run check        # lint + typecheck
```

After redeploying contracts, run `bun run gen:abis` to refresh `src/lib/abis.ts`, then `bun run setup` once to register the price feeds and seed the vault.

### Environment variables

| Name | Purpose |
| --- | --- |
| `VITE_MARKET_ADDRESS` | Deployed market contract |
| `VITE_ORACLE_ADDRESS` | Deployed oracle adapter |
| `VITE_FEED_BTC`, `VITE_FEED_ETH`, `VITE_FEED_SOL` | Price feed contracts (testnet mocks) |
| `VITE_DEPLOY_BLOCK` | Block of the first deployment, used to bound event scans |
| `VITE_KEEPER_ADDRESS` | Address of the keeper wallet (public) |
| `KEEPER_PRIVATE_KEY` | Keeper wallet key, used only by the scripts. Never exposed to the browser |
| `RPC_PROXY_BASE_URL`, `RPC_PROXY_TOKEN`, `RPC_PROXY_CHAINS` | Optional outside Arc Studio. Scripts fall back to the public Arc Testnet RPC |

## Notes

- Testnet only. Live data is pushed over WebSocket from the Arc RPC and Coinbase. Prices on-chain come from mock Chainlink-compatible feeds that the keeper updates from Coinbase. To use real Chainlink feeds, call `setFeed` on the oracle adapter with the real feed addresses.
- The chart line comes from Coinbase for smoothness. Settlement and stop loss / take profit always use the oracle price.
