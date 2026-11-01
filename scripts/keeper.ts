/**
 * Keeper bot (run: bun run keeper). Runs forever:
 *  - pushes Coinbase spot prices to the mock Chainlink feeds (testnet only)
 *  - pokes the oracle so realized volatility keeps sampling
 *  - keeps one open market per asset and duration
 *  - settles expired markets with the first oracle round at or after expiry
 *  - executes stop-loss / take-profit orders when the oracle price crosses a level
 * The contracts are permissionless for market creation, settlement and order execution,
 * so this bot is a convenience, not a trust point.
 */
import { aggregatorAbi, marketAbi, oracleAbi } from '../src/lib/abis'
import {
  ASSETS,
  DURATIONS,
  account,
  addresses,
  coinbaseSpot8,
  publicClient,
  send,
  sleep,
  walletClient,
} from './lib'

const TICK_MS = 5_000
const PUSH_HEARTBEAT_S = 45
const PUSH_DEVIATION_BPS = 5n
const POKE_INTERVAL_S = 60
const ORDER_LOOKBACK_BLOCKS = 20_000n
const LOG_CHUNK = 2_000n

type OrderKey = string
interface TrackedOrder {
  marketId: bigint
  user: `0x${string}`
  isUp: boolean
}

const lastPush = ASSETS.map(() => ({ price: 0n, at: 0 }))
const lastPoke = ASSETS.map(() => 0)
const orders = new Map<OrderKey, TrackedOrder>()
let scannedTo = 0n

const nowS = () => Math.floor(Date.now() / 1000)
const key = (marketId: bigint, user: string, isUp: boolean) => `${marketId}:${user.toLowerCase()}:${isUp}`
const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`)

async function pushPrices() {
  for (const asset of ASSETS) {
    try {
      const price = await coinbaseSpot8(asset.product)
      const prev = lastPush[asset.id]
      const age = nowS() - prev.at
      const moved = prev.price === 0n ? 10_000n : ((price > prev.price ? price - prev.price : prev.price - price) * 10_000n) / prev.price
      if (age < PUSH_HEARTBEAT_S && moved < PUSH_DEVIATION_BPS) continue
      await send(
        await walletClient.writeContract({
          address: addresses.feeds[asset.id],
          abi: aggregatorAbi,
          functionName: 'setPrice',
          args: [price],
        }),
      )
      lastPush[asset.id] = { price, at: nowS() }
      if (nowS() - lastPoke[asset.id] >= POKE_INTERVAL_S) {
        await send(
          await walletClient.writeContract({
            address: addresses.oracle,
            abi: oracleAbi,
            functionName: 'poke',
            args: [asset.id],
          }),
        )
        lastPoke[asset.id] = nowS()
      }
    } catch (e) {
      log(`price push ${asset.key} failed: ${(e as Error).message.split('\n')[0]}`)
    }
  }
}

async function recentMarkets() {
  const count = await publicClient.readContract({ address: addresses.market, abi: marketAbi, functionName: 'marketCount' })
  const take = count > 120n ? 120n : count
  const from = count - take + 1n
  if (take === 0n) return { from: 1n, list: [] as readonly never[] }
  const list = await publicClient.readContract({
    address: addresses.market,
    abi: marketAbi,
    functionName: 'getMarketsRange',
    args: [from, take],
  })
  return { from, list }
}

/** Binary search the first feed round whose updatedAt >= expiry. Returns undefined if none yet. */
async function firstRoundAtOrAfter(feed: `0x${string}`, expiry: bigint): Promise<bigint | undefined> {
  const latest = await publicClient.readContract({ address: feed, abi: aggregatorAbi, functionName: 'latestRoundData' })
  if (latest[3] < expiry) return undefined
  let lo = 1n
  let hi = latest[0]
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const r = await publicClient.readContract({
      address: feed,
      abi: aggregatorAbi,
      functionName: 'getRoundData',
      args: [mid],
    })
    if (r[3] >= expiry) hi = mid
    else lo = mid + 1n
  }
  return lo
}

async function maintainMarkets() {
  const { from, list } = await recentMarkets()
  const now = BigInt(nowS())
  // settle expired
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    if (m.status !== 0 || now < BigInt(m.expiry)) continue
    const id = from + BigInt(i)
    try {
      const round = await firstRoundAtOrAfter(addresses.feeds[m.assetId], BigInt(m.expiry))
      if (round === undefined) continue
      await send(
        await walletClient.writeContract({
          address: addresses.market,
          abi: marketAbi,
          functionName: 'settle',
          args: [id, round],
        }),
      )
      log(`settled market ${id}`)
    } catch (e) {
      log(`settle ${id} failed: ${(e as Error).message.split('\n')[0]}`)
    }
  }
  // keep one open market per asset and duration
  for (const asset of ASSETS) {
    for (const duration of DURATIONS) {
      const open = list.some(
        (m) =>
          m.assetId === asset.id &&
          m.status === 0 &&
          BigInt(m.expiry) - BigInt(m.createdAt) === BigInt(duration) &&
          BigInt(m.expiry) > now + 20n,
      )
      if (open) continue
      try {
        await send(
          await walletClient.writeContract({
            address: addresses.market,
            abi: marketAbi,
            functionName: 'createMarket',
            args: [asset.id, 0n, duration],
          }),
        )
        log(`opened ${asset.key} ${duration}s market`)
      } catch (e) {
        log(`create ${asset.key} ${duration}s failed: ${(e as Error).message.split('\n')[0]}`)
      }
    }
  }
}

async function scanOrders() {
  const head = await publicClient.getBlockNumber()
  const deployBlock = BigInt(process.env.VITE_DEPLOY_BLOCK ?? '0')
  if (scannedTo === 0n) {
    const start = head > ORDER_LOOKBACK_BLOCKS ? head - ORDER_LOOKBACK_BLOCKS : 0n
    scannedTo = (start > deployBlock ? start : deployBlock) - 1n
    log(`order scan starts at block ${scannedTo + 1n} (head ${head})`)
  }
  while (scannedTo < head) {
    const fromBlock = scannedTo + 1n
    const toBlock = fromBlock + LOG_CHUNK - 1n > head ? head : fromBlock + LOG_CHUNK - 1n
    const [set, cancelled, executed] = await Promise.all([
      publicClient.getContractEvents({ address: addresses.market, abi: marketAbi, eventName: 'OrderSet', fromBlock, toBlock }),
      publicClient.getContractEvents({ address: addresses.market, abi: marketAbi, eventName: 'OrderCancelled', fromBlock, toBlock }),
      publicClient.getContractEvents({ address: addresses.market, abi: marketAbi, eventName: 'OrderExecuted', fromBlock, toBlock }),
    ])
    for (const l of set) {
      const a = l.args
      if (a.marketId === undefined || !a.user || a.isUp === undefined) continue
      orders.set(key(a.marketId, a.user, a.isUp), { marketId: a.marketId, user: a.user, isUp: a.isUp })
    }
    for (const l of [...cancelled, ...executed]) {
      const a = l.args
      if (a.marketId === undefined || !a.user || a.isUp === undefined) continue
      orders.delete(key(a.marketId, a.user, a.isUp))
    }
    scannedTo = toBlock
  }
}

async function runOrders() {
  const now = BigInt(nowS())
  for (const [k, o] of orders) {
    try {
      const m = await publicClient.readContract({
        address: addresses.market,
        abi: marketAbi,
        functionName: 'getMarket',
        args: [o.marketId],
      })
      if (m.status !== 0 || now >= BigInt(m.expiry)) {
        orders.delete(k)
        continue
      }
      const order = await publicClient.readContract({
        address: addresses.market,
        abi: marketAbi,
        functionName: 'getOrder',
        args: [o.marketId, o.user, o.isUp],
      })
      if (order.stopPrice === 0n && order.takeProfitPrice === 0n) {
        orders.delete(k)
        continue
      }
      const [spot] = await publicClient.readContract({
        address: addresses.oracle,
        abi: oracleAbi,
        functionName: 'getPrice',
        args: [m.assetId],
      })
      const stop = order.stopPrice
      const tp = order.takeProfitPrice
      const hit = o.isUp
        ? (stop !== 0n && spot <= stop) || (tp !== 0n && spot >= tp)
        : (stop !== 0n && spot >= stop) || (tp !== 0n && spot <= tp)
      if (!hit) continue
      await send(
        await walletClient.writeContract({
          address: addresses.market,
          abi: marketAbi,
          functionName: 'executeOrder',
          args: [o.marketId, o.user, o.isUp],
        }),
      )
      orders.delete(k)
      log(`executed order market ${o.marketId} ${o.isUp ? 'UP' : 'DOWN'} for ${o.user}`)
    } catch (e) {
      log(`order ${k} failed: ${(e as Error).message.split('\n')[0]}`)
    }
  }
}

log(`keeper ${account.address} started, market ${addresses.market}`)
for (;;) {
  try {
    await pushPrices()
    await maintainMarkets()
    await scanOrders()
    await runOrders()
  } catch (e) {
    log(`tick failed: ${(e as Error).message.split('\n')[0]}`)
  }
  await sleep(TICK_MS)
}
