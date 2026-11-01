/**
 * One-time wiring after deployment (run: bun run scripts/setup.ts).
 * 1. Seeds each mock Chainlink feed with a real Coinbase spot price.
 * 2. Registers the three feeds on the oracle adapter with vol bounds.
 * 3. Deposits keeper USDC into the vault (keeps a gas reserve).
 * Safe to re-run: setFeed resets the vol history, so only re-run if you mean to.
 */
import { erc20Abi, parseUnits } from 'viem'
import { aggregatorAbi, marketAbi, oracleAbi } from '../src/lib/abis'
import { getUsdc } from '../src/onchain-facts'
import { ASSETS, account, addresses, coinbaseSpot8, publicClient, send, walletClient } from './lib'

const VOL = {
  BTC: { min: '0.30', max: '1.5', def: '0.55' },
  ETH: { min: '0.40', max: '2.0', def: '0.75' },
  SOL: { min: '0.50', max: '2.5', def: '0.95' },
} as const

const FEED_MAX_STALENESS = 600
const GAS_RESERVE_USDC = '3'

const usdc = getUsdc(5042002)
if (!usdc) throw new Error('USDC missing from onchain facts')
const USDC = usdc.address as `0x${string}`

for (const asset of ASSETS) {
  const feed = addresses.feeds[asset.id]
  const price = await coinbaseSpot8(asset.product)
  await send(
    await walletClient.writeContract({ address: feed, abi: aggregatorAbi, functionName: 'setPrice', args: [price] }),
  )
  const v = VOL[asset.key]
  await send(
    await walletClient.writeContract({
      address: addresses.oracle,
      abi: oracleAbi,
      functionName: 'setFeed',
      args: [asset.id, feed, FEED_MAX_STALENESS, parseUnits(v.min, 18), parseUnits(v.max, 18), parseUnits(v.def, 18)],
    }),
  )
  console.log(`${asset.key}: feed seeded at ${Number(price) / 1e8} and registered`)
}

const balance = await publicClient.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [account.address],
})
const reserve = parseUnits(GAS_RESERVE_USDC, usdc.decimals)
if (balance > reserve) {
  const amount = balance - reserve
  await send(
    await walletClient.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'approve',
      args: [addresses.market, amount],
    }),
  )
  await send(
    await walletClient.writeContract({
      address: addresses.market,
      abi: marketAbi,
      functionName: 'deposit',
      args: [amount],
    }),
  )
  console.log(`Deposited ${Number(amount) / 10 ** usdc.decimals} USDC into the vault`)
}
