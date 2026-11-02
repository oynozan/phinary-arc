/**
 * One-time wiring after deployment (run: bun run setup). Only assets with a VITE_FEED_* address are touched.
 * The forge deploy script (contracts/script/DeployPhinary.s.sol) deploys the feeds and registers them on the oracle
 * with vol bounds on both networks, but pushes no price and deposits nothing.
 * Testnet (NETWORK unset or testnet):
 *   1. Seeds each mock Chainlink feed that has no round yet with a real spot price (Coinbase for crypto, Kraken
 *      xStocks for NVDA/AAPL).
 *   2. Registers the feeds the deploy script did not (contracts deployed by hand) on the oracle with vol bounds.
 *   3. Deposits keeper USDC into the vault (keeps a gas reserve), or DEPOSIT_USDC if set.
 * Mainnet (NETWORK=mainnet): only checks each StreamsFeed (description, 18 decimals, stream id, registered on the
 *   oracle) and submits one signed Data Streams report to confirm a fresh latestRoundData. It deposits only when
 *   DEPOSIT_USDC is set.
 * Safe to re-run: registered assets whose feed has a round and an existing keeper deposit are skipped,
 * so a re-run neither wipes the vol history nor relocks the keeper's LP shares or sweeps its gas money.
 * SETUP_FORCE=1 re-seeds and re-registers every testnet feed (resetting its vol history) and deposits again.
 */
import { BaseError, ContractFunctionRevertedError, erc20Abi, formatUnits, parseUnits, type Address } from 'viem'
import { aggregatorAbi, marketAbi, oracleAbi, streamsFeedAbi } from '../src/lib/abis'
import { NETWORK, USDC, account, addresses, ageOnInclusion, enabledAssets, isRevert, publicClient, send, spot8, streamId, streamsReport, walletClient } from './lib'

const VOL = {
  BTC: { min: '0.30', max: '1.5', def: '0.55' },
  ETH: { min: '0.40', max: '2.0', def: '0.75' },
  SOL: { min: '0.50', max: '2.5', def: '0.95' },
  NVDA: { min: '0.25', max: '1.5', def: '0.50' },
  AAPL: { min: '0.15', max: '1.0', def: '0.30' },
} as const

const FEED_MAX_STALENESS = 600
const GAS_RESERVE_USDC = '3'
const FORCE = process.env.SETUP_FORCE === '1'
const DEPOSIT_USDC = process.env.DEPOSIT_USDC

async function registered(assetId: number): Promise<boolean> {
  try {
    await publicClient.readContract({ address: addresses.oracle, abi: oracleAbi, functionName: 'getObservationCount', args: [assetId] })
    return true
  } catch (e) {
    const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : undefined
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'AssetNotEnabled') return false
    throw e
  }
}

/** False while the feed has no round yet: a fresh MockAggregator reverts in latestRoundData. */
async function hasRound(feed: Address): Promise<boolean> {
  try {
    const [id, , , updatedAt] = await publicClient.readContract({ address: feed, abi: aggregatorAbi, functionName: 'latestRoundData' })
    return id !== 0n && updatedAt !== 0n
  } catch (e) {
    if (isRevert(e)) return false
    throw e
  }
}

console.log(`${NETWORK}: ${enabledAssets.map((a) => a.key).join(', ') || 'no assets (set VITE_FEED_*)'}`)
const failures: string[] = []
for (const asset of enabledAssets) {
  const feed = addresses.feeds[asset.id]!
  if (NETWORK === 'mainnet') {
    const read = <F extends 'description' | 'decimals' | 'feedId' | 'maxReportAge'>(functionName: F) =>
      publicClient.readContract({ address: feed, abi: streamsFeedAbi, functionName })
    const [description, decimals, feedId, maxAge] = await Promise.all([read('description'), read('decimals'), read('feedId'), read('maxReportAge')])
    const problems = [
      decimals !== 18 && `decimals ${decimals}, expected 18`,
      feedId.toLowerCase() !== streamId(asset).toLowerCase() && `stream ${feedId}, expected ${streamId(asset)}`,
      !(await registered(asset.id)) && 'not registered on the oracle (run the forge deploy script)',
    ].filter((p): p is string => !!p)
    if (problems.length === 0) {
      // a report past maxReportAge on inclusion would revert StaleReport: refetch once, then report it (as the keeper does)
      let report = await streamsReport(feedId)
      if (report && (await ageOnInclusion(report.observedAt)) > maxAge) report = await streamsReport(feedId)
      const age = report ? await ageOnInclusion(report.observedAt) : 0n
      if (!report) {
        console.log(`${asset.key}: market closed, freshness not checked`)
      } else if (age > maxAge) {
        problems.push(`latest Data Streams report would be ${age}s old on inclusion (maxReportAge ${maxAge}s)`)
      } else {
        await send(await walletClient.writeContract({ address: feed, abi: streamsFeedAbi, functionName: 'submit', args: [report.fullReport] }))
        const [, answer, , updatedAt] = await publicClient.readContract({ address: feed, abi: aggregatorAbi, functionName: 'latestRoundData' })
        if (answer <= 0n || updatedAt < report.observedAt) problems.push(`latest round ${answer} at ${updatedAt} is older than the submitted report`)
        else console.log(`${asset.key}: ${description} ok, ${formatUnits(answer, 18)} at ${updatedAt}`)
      }
    }
    for (const p of problems) failures.push(`${asset.key} (${feed}): ${p}`)
    continue
  }
  const known = !FORCE && (await registered(asset.id))
  if (known && (await hasRound(feed))) {
    console.log(`${asset.key}: already registered, skipped (SETUP_FORCE=1 re-registers and resets its vol history)`)
    continue
  }
  const price = await spot8(asset)
  await send(
    await walletClient.writeContract({ address: feed, abi: aggregatorAbi, functionName: 'setPrice', args: [price] }),
  )
  if (!known) {
    const v = VOL[asset.key]
    await send(
      await walletClient.writeContract({
        address: addresses.oracle,
        abi: oracleAbi,
        functionName: 'setFeed',
        args: [asset.id, feed, FEED_MAX_STALENESS, parseUnits(v.min, 18), parseUnits(v.max, 18), parseUnits(v.def, 18)],
      }),
    )
  }
  console.log(`${asset.key}: feed seeded at ${Number(price) / 1e8}${known ? ' (already registered)' : ' and registered'}`)
}
if (failures.length > 0) throw new Error(`feed check failed:\n  ${failures.join('\n  ')}`)

const balance = await publicClient.readContract({
  address: USDC.address,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [account.address],
})
const reserve = parseUnits(GAS_RESERVE_USDC, USDC.decimals)
const shares = await publicClient.readContract({ address: addresses.market, abi: marketAbi, functionName: 'sharesOf', args: [account.address] })
if (NETWORK === 'mainnet' && !DEPOSIT_USDC) {
  console.log('Mainnet: no deposit (set DEPOSIT_USDC=<amount> to deposit)')
} else if (shares > 0n && !FORCE && !DEPOSIT_USDC) {
  console.log('Keeper already holds vault shares, deposit skipped (SETUP_FORCE=1 deposits again)')
} else if (DEPOSIT_USDC || balance > reserve) {
  const amount = DEPOSIT_USDC ? parseUnits(DEPOSIT_USDC, USDC.decimals) : balance - reserve
  if (amount <= 0n || amount + reserve > balance) {
    throw new Error(`DEPOSIT_USDC ${DEPOSIT_USDC} must be positive and leave ${GAS_RESERVE_USDC} USDC for gas (balance ${formatUnits(balance, USDC.decimals)})`)
  }
  await send(
    await walletClient.writeContract({
      address: USDC.address,
      abi: erc20Abi,
      functionName: 'approve',
      args: [addresses.market, amount],
    }),
  )
  const minted = await publicClient.readContract({ address: addresses.market, abi: marketAbi, functionName: 'previewDeposit', args: [amount] })
  await send(
    await walletClient.writeContract({
      address: addresses.market,
      abi: marketAbi,
      functionName: 'deposit',
      args: [amount, (minted * 995n) / 1000n],
    }),
  )
  console.log(`Deposited ${formatUnits(amount, USDC.decimals)} USDC into the vault`)
}
