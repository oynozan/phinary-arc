/**
 * Keeper bot (run: bun run keeper). Runs forever:
 *  - keeps the feeds fresh (KEEPER_PUSH_PRICES=false turns it off): on testnet it pushes Coinbase (crypto) and
 *    Kraken xStocks (NVDA, AAPL) prices to the mock feeds; on mainnet (NETWORK=mainnet) it invents nothing and
 *    submits the latest signed Chainlink Data Streams report to each StreamsFeed
 *  - pokes the oracle so realized volatility keeps sampling
 *  - keeps one open market it created itself per asset and duration
 *  - settles expired markets, and voids the ones that cannot settle once the contract's 24h void delay has passed.
 *    Testnet: with the first oracle round at or after expiry. Mainnet: submits the Data Streams report observed at
 *    expiry to StreamsFeed.submitSettlement (an earlier report also overrides someone else's later one) and settles
 *    with roundId 0 once that record is final (DISPUTE_PERIOD after its first submission)
 *  - executes stop-loss / take-profit orders when the oracle price crosses a level
 * The contracts are permissionless for market creation, settlement and order execution,
 * so this bot is a convenience, not a trust point.
 *
 * Several instances can run side by side: give each its KEEPER_INDEX (0-based) and the same
 * KEEPER_COUNT, and list the other instances' addresses in KEEPER_PEERS (comma separated). Each
 * instance must sign with its own key: two processes sharing a key race on nonces. Each instance
 * opens and settles its own share right away and takes over the rest once they are SLOT_GRACE_S
 * overdue. Instance 0 alone pushes prices and pokes the oracle; the others step in once a feed or
 * a poke is SLOT_GRACE_S overdue.
 */
import { getAbiItem, parseEventLogs, type Address, type Hex } from 'viem'
import { aggregatorAbi, marketAbi, oracleAbi, streamsFeedAbi } from '../src/lib/abis'
import {
  ASSETS,
  DURATIONS,
  NETWORK,
  ORACLE_AGE_RATIO,
  PUSH_LAG_S,
  account,
  addresses,
  ageOnInclusion,
  ageRuleDue,
  enabledAssets,
  isRevert,
  keeperSlot,
  publicClient,
  reportHash,
  send,
  sleep,
  spot8,
  streamsReport,
  streamsSettlementReport,
  walletClient,
  type Asset,
} from './lib'

const TICK_MS = 5_000
const PUSH_HEARTBEAT_S = 45n
const PUSH_DEVIATION_BPS = 2n
// Trades revert once the oracle age * 4 exceeds the time left, so a push is also due whenever the age could cross
// that before the next tick's push lands (ageRuleDue). Inside this window the heartbeat alone no longer keeps the
// ratio, and every price change is pushed as well.
const NEAR_EXPIRY_S = ORACLE_AGE_RATIO * (PUSH_HEARTBEAT_S + PUSH_LAG_S) + PUSH_LAG_S
// A move this large is pushed only once the next tick confirms it (within JUMP_CONFIRM_BPS).
const MAX_JUMP_BPS = 2_000n
const JUMP_CONFIRM_BPS = 100n
const POKE_INTERVAL_S = 60n // PriceOracleAdapter.MIN_OBS_INTERVAL
const ROTATE_BEFORE_S = 20n
const CLOSE_BUFFER_S = 15n // PredictionMarket.TRADING_CLOSE_BUFFER
const VOID_DELAY_S = 86_400n // PredictionMarket.VOID_DELAY
const SETTLE_WINDOW_S = 10n // StreamsFeed.SETTLE_WINDOW
const DISPUTE_PERIOD_S = 300n // StreamsFeed.DISPUTE_PERIOD
const SLOT_GRACE_S = 30n
const LOOKBACK_BLOCKS = 20_000n // only when VITE_DEPLOY_BLOCK is unset
const LOG_CHUNK = 10_000n
const MARKET_PAGE = 200n

const PUSH_PRICES = process.env.KEEPER_PUSH_PRICES !== 'false'
const MAINNET = NETWORK === 'mainnet'
if (PUSH_PRICES && MAINNET && !(process.env.STREAMS_API_KEY && process.env.STREAMS_API_SECRET)) {
  throw new Error('NETWORK=mainnet needs STREAMS_API_KEY and STREAMS_API_SECRET (or KEEPER_PUSH_PRICES=false)')
}
const { count: KEEPER_COUNT, index: KEEPER_INDEX } = keeperSlot(process.env.KEEPER_COUNT || undefined, process.env.KEEPER_INDEX || undefined)
// instance 0 pushes and pokes; the others wait this much longer before stepping in
const PRICE_GRACE_S = KEEPER_INDEX === 0 ? 0n : SLOT_GRACE_S
// Markets these addresses created are the rolling markets; anyone else's are custom strikes.
const rollingCreators = new Set(
  [account.address, ...(process.env.KEEPER_PEERS ?? '').split(',')].map((a) => a.trim().toLowerCase()).filter(Boolean),
)

type OrderKey = string
interface TrackedOrder {
  marketId: bigint
  user: `0x${string}`
  isUp: boolean
}

const feeds: (Address | undefined)[] = [...addresses.feeds] // replaced by the oracle's FeedSet events
const streamIds = new Map<Address, Hex>() // StreamsFeed address -> its feedId()
const maxReportAges = new Map<Address, bigint>() // StreamsFeed address -> its maxReportAge()
const lastPush = ASSETS.map(() => ({ price: 0n, at: 0n }))
const pendingJump = ASSETS.map(() => 0n)
const lastPoke = ASSETS.map(() => 0n)
const orders = new Map<OrderKey, TrackedOrder>()
const rolling = new Set<bigint>()
const unsettleable = new Set<bigint>()
const vacantSince = new Map<string, bigint>()
let scannedTo: bigint | undefined
let caughtUp = false // a log scan has reached the head once
let lowestOpen = 1n

const key = (marketId: bigint, user: string, isUp: boolean) => `${marketId}:${user.toLowerCase()}:${isUp}`
const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`)
const errMsg = (e: unknown) => (e as Error).message.split('\n')[0]
const bps = (from: bigint, to: bigint) => ((to > from ? to - from : from - to) * 10_000n) / from
const mine = (i: bigint | number) => Number(BigInt(i) % BigInt(KEEPER_COUNT)) === KEEPER_INDEX

type Listed = Awaited<ReturnType<typeof loadMarkets>>[number]

/** Every market from the lowest id that may still be open; moves that cursor past closed markets. */
async function loadMarkets() {
  const count = await publicClient.readContract({ address: addresses.market, abi: marketAbi, functionName: 'marketCount' })
  const list = []
  for (let from = lowestOpen; from <= count; from += MARKET_PAGE) {
    const page = await publicClient.readContract({
      address: addresses.market,
      abi: marketAbi,
      functionName: 'getMarketsRange',
      args: [from, MARKET_PAGE],
    })
    list.push(...page.map((m, i) => ({ ...m, id: from + BigInt(i) })))
  }
  lowestOpen = list.find((m) => m.status === 0)?.id ?? count + 1n
  return list
}

/** The feed's latest round, or undefined while it has none (a StreamsFeed reverts before its first report). */
async function latestRound(feed: Address) {
  try {
    const r = await publicClient.readContract({ address: feed, abi: aggregatorAbi, functionName: 'latestRoundData' })
    return r[3] === 0n ? undefined : { id: r[0], answer: r[1], updatedAt: r[3] }
  } catch (e) {
    if (isRevert(e)) return undefined
    throw e
  }
}

async function streamOf(feed: Address) {
  let id = streamIds.get(feed)
  if (!id) {
    id = await publicClient.readContract({ address: feed, abi: streamsFeedAbi, functionName: 'feedId' })
    streamIds.set(feed, id)
  }
  return id
}

/**
 * Testnet: a confirmed source price for setPrice. Mainnet: the latest signed report for submit, only while it would still be
 * within maxReportAge on inclusion (ageOnInclusion; one refetch, then the next tick).
 */
async function nextPrice(asset: Asset, feed: Address, prev: { price: bigint }) {
  if (MAINNET) {
    const id = await streamOf(feed)
    let maxAge = maxReportAges.get(feed)
    if (maxAge === undefined) {
      maxAge = await publicClient.readContract({ address: feed, abi: streamsFeedAbi, functionName: 'maxReportAge' })
      maxReportAges.set(feed, maxAge)
    }
    for (let i = 0; i < 2; i++) {
      const report = await streamsReport(id)
      if (!report) return undefined
      const age = await ageOnInclusion(report.observedAt)
      if (age <= maxAge) return { price: report.price, at: report.observedAt, fullReport: report.fullReport }
      log(`price push ${asset.key}: report would be ${age}s old on inclusion (maxReportAge ${maxAge}s), skipped`)
    }
    return undefined
  }
  const price = await spot8(asset)
  if (prev.price !== 0n && bps(prev.price, price) >= MAX_JUMP_BPS) {
    const pending = pendingJump[asset.id]
    pendingJump[asset.id] = price
    if (pending === 0n || bps(pending, price) > JUMP_CONFIRM_BPS) {
      log(`price push ${asset.key} held: ${bps(prev.price, price)} bps jump, waiting for the next tick to confirm`)
      return undefined
    }
  }
  pendingJump[asset.id] = 0n
  return { price, at: undefined, fullReport: undefined }
}

async function pushPrices(now: bigint, markets: readonly Listed[]) {
  for (const asset of enabledAssets) {
    const feed = feeds[asset.id]
    if (!feed) continue
    try {
      const prev = lastPush[asset.id]
      // the backup instances follow the feed itself, since they do not push
      if (prev.price === 0n || PRICE_GRACE_S > 0n) {
        const r = await latestRound(feed)
        if (r && r.answer > 0n) Object.assign(prev, { price: r.answer, at: r.updatedAt })
      }
      const age = now - prev.at
      const open = markets.filter((m) => m.assetId === asset.id && m.status === 0)
      // testnet: a market expired after the last push, so push now for its settlement round (mainnet settles on submitSettlement)
      const expired = !MAINNET && open.some((m) => BigInt(m.expiry) > prev.at && BigInt(m.expiry) + PRICE_GRACE_S <= now)
      if (PRICE_GRACE_S > 0n && !expired && age < PUSH_HEARTBEAT_S + PRICE_GRACE_S) continue
      const next = await nextPrice(asset, feed, prev)
      if (!next) continue
      if (next.at !== undefined && next.at <= prev.at) continue // no report newer than the latest round yet
      const moved = prev.price === 0n ? 10_000n : bps(prev.price, next.price)
      const near = open.some((m) => BigInt(m.expiry) > now && BigInt(m.expiry) <= now + NEAR_EXPIRY_S)
      const due =
        age >= PUSH_HEARTBEAT_S ||
        moved >= PUSH_DEVIATION_BPS ||
        expired ||
        open.some((m) => ageRuleDue(age, BigInt(m.expiry) - now)) ||
        (near && next.price !== prev.price)
      if (!due) continue
      await send(
        next.fullReport
          ? await walletClient.writeContract({ address: feed, abi: streamsFeedAbi, functionName: 'submit', args: [next.fullReport] })
          : await walletClient.writeContract({ address: feed, abi: aggregatorAbi, functionName: 'setPrice', args: [next.price] }),
      )
      lastPush[asset.id] = { price: next.price, at: next.at ?? now }
    } catch (e) {
      log(`price push ${asset.key} failed: ${errMsg(e)}`)
    }
  }
}

async function pokeOracle(now: bigint) {
  for (const asset of enabledAssets) {
    if (PRICE_GRACE_S > 0n && lastPoke[asset.id] === 0n) lastPoke[asset.id] = now // a backup gives instance 0 a full interval first
    if (now - lastPoke[asset.id] < POKE_INTERVAL_S + PRICE_GRACE_S) continue
    try {
      await send(
        await walletClient.writeContract({
          address: addresses.oracle,
          abi: oracleAbi,
          functionName: 'poke',
          args: [asset.id],
        }),
      )
      lastPoke[asset.id] = now
    } catch (e) {
      log(`poke ${asset.key} failed: ${errMsg(e)}`)
    }
  }
}

/** Round `id`, or undefined when the feed reverts for it (no such round). Transport errors propagate so the tick retries. */
async function roundAt(feed: Address, id: bigint) {
  try {
    const r = await publicClient.readContract({ address: feed, abi: aggregatorAbi, functionName: 'getRoundData', args: [id] })
    return r[3] === 0n ? undefined : { answer: r[1], updatedAt: r[3] }
  } catch (e) {
    if (isRevert(e)) return undefined // Chainlink proxies and StreamsFeed revert for ids that do not exist
    throw e
  }
}

/** First id in [lo, hi] whose round is missing or at/after expiry (rounds are contiguous within a phase). */
async function bisect(feed: Address, lo: bigint, hi: bigint, expiry: bigint) {
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n
    const r = await roundAt(feed, mid)
    if (!r || r.updatedAt >= expiry) hi = mid
    else lo = mid + 1n
  }
  return lo
}

/**
 * The settlement round: the first round at or after expiry, whose previous round is before expiry.
 * Chainlink proxy ids are (phaseId << 64) | n, so the search stays inside one phase, the latest one or,
 * when that phase began after expiry, the one before it. Returns undefined while no round has reached
 * expiry, and null when the adapter rejects every candidate (a phase's first round, or a bad answer).
 */
async function settlementRound(feed: Address, expiry: bigint): Promise<bigint | null | undefined> {
  const last = await latestRound(feed)
  if (!last || last.updatedAt < expiry) return undefined
  const latest = last.id
  let phase = latest >> 64n
  let round = await bisect(feed, (phase << 64n) | 1n, latest, expiry)
  if (phase > 1n && round === ((phase << 64n) | 1n)) {
    phase -= 1n
    const base = phase << 64n
    // the previous phase's length is unknown: double n until a round is missing or at/after expiry
    let below = 0n
    let n = 1n
    for (;;) {
      const r = await roundAt(feed, base | n)
      if (!r || r.updatedAt >= expiry) break
      below = n
      n *= 2n
    }
    round = await bisect(feed, base | (below + 1n), base | n, expiry)
  }
  const r = await roundAt(feed, round)
  const local = round & ((1n << 64n) - 1n)
  if (!r || r.answer <= 0n || (local === 1n && round !== 1n)) return null
  return round
}

/**
 * Mainnet: true once the StreamsFeed settlement record of `expiry` is final, DISPUTE_PERIOD after its first submission (settle
 * then takes roundId 0). Until then it submits the report observed at expiry (else the earliest one in the window) whenever
 * the feed would take it over the stored one (earlier, or same second with a smaller reportHash), which also overrides a
 * report someone else stored first. A failed report lookup counts as "not final", so the void delay still applies.
 */
async function settlementFinal(feed: Address, expiry: bigint, now: bigint) {
  const [, observedAt, firstSubmittedAt, storedHash] = await publicClient.readContract({ address: feed, abi: streamsFeedAbi, functionName: 'settlements', args: [expiry] })
  const stored = firstSubmittedAt !== 0
  if (stored && now >= BigInt(firstSubmittedAt) + DISPUTE_PERIOD_S) return true
  const report = await streamsSettlementReport(await streamOf(feed), expiry, SETTLE_WINDOW_S).catch(
    (e) => void log(`settlement report ${feed} expiry ${expiry} failed: ${errMsg(e)}`),
  )
  if (!report) return false
  const at = BigInt(observedAt)
  if (stored && (report.observedAt > at || (report.observedAt === at && BigInt(reportHash(report.fullReport)) >= BigInt(storedHash)))) return false
  await send(await walletClient.writeContract({ address: feed, abi: streamsFeedAbi, functionName: 'submitSettlement', args: [report.fullReport, expiry] }))
  log(`submitted settlement report ${feed} expiry ${expiry} observed at ${report.observedAt}`)
  return false
}

/** Settles expired markets. Until the log scan has caught up the feed may be outdated, so it only settles then, never voids. */
async function settleMarkets(now: bigint, markets: readonly Listed[]) {
  const records = new Map<string, Promise<boolean>>() // mainnet: one settlementFinal per feed and expiry per tick
  for (const m of markets) {
    const expiry = BigInt(m.expiry)
    const feed = feeds[m.assetId]
    if (m.status !== 0 || now < expiry || !feed) continue
    if (KEEPER_COUNT > 1 && !mine(m.id) && now < expiry + SLOT_GRACE_S) continue
    try {
      let round: bigint | null | undefined
      if (MAINNET) {
        const k = `${feed}:${expiry}`
        if (!records.has(k)) records.set(k, settlementFinal(feed, expiry, now))
        round = (await records.get(k)) ? 0n : undefined
      } else round = unsettleable.has(m.id) ? null : await settlementRound(feed, expiry)
      if ((round === null || round === undefined) && !caughtUp) continue
      if (round === null && !unsettleable.has(m.id)) {
        unsettleable.add(m.id)
        log(`market ${m.id} cannot settle (no valid round inside one feed phase); it voids after the delay`)
      }
      if (round === undefined || round === null) {
        if (now < expiry + VOID_DELAY_S) continue
        await send(
          await walletClient.writeContract({
            address: addresses.market,
            abi: marketAbi,
            functionName: 'voidMarket',
            args: [m.id],
          }),
        )
        log(`voided market ${m.id}`)
        continue
      }
      await send(
        await walletClient.writeContract({
          address: addresses.market,
          abi: marketAbi,
          functionName: 'settle',
          args: [m.id, round],
        }),
      )
      log(`settled market ${m.id}`)
    } catch (e) {
      log(`settle ${m.id} failed: ${errMsg(e)}`)
    }
  }
}

/** Keeps one open rolling market per asset and duration; other creators' markets are custom strikes. */
async function rotateMarkets(now: bigint, markets: readonly Listed[]) {
  for (const asset of enabledAssets) {
    for (const [d, duration] of DURATIONS.entries()) {
      const slot = `${asset.id}:${duration}`
      const open = markets.some(
        (m) =>
          rolling.has(m.id) &&
          m.assetId === asset.id &&
          m.status === 0 &&
          BigInt(m.expiry) - BigInt(m.createdAt) === BigInt(duration) &&
          BigInt(m.expiry) > now + ROTATE_BEFORE_S,
      )
      if (open) {
        vacantSince.delete(slot)
        continue
      }
      const since = vacantSince.get(slot) ?? now
      vacantSince.set(slot, since)
      if (!mine(asset.id * DURATIONS.length + d) && now - since < SLOT_GRACE_S) continue
      try {
        const receipt = await send(
          await walletClient.writeContract({
            address: addresses.market,
            abi: marketAbi,
            functionName: 'createMarket',
            args: [asset.id, 0n, duration],
          }),
        )
        for (const l of parseEventLogs({ abi: marketAbi, eventName: 'MarketCreated', logs: receipt.logs })) rolling.add(l.args.marketId)
        vacantSince.delete(slot)
        log(`opened ${asset.key} ${duration}s market`)
      } catch (e) {
        log(`create ${asset.key} ${duration}s failed: ${errMsg(e)}`)
      }
    }
  }
}

const marketEvents = [
  getAbiItem({ abi: marketAbi, name: 'MarketCreated' }),
  getAbiItem({ abi: marketAbi, name: 'OrderSet' }),
  getAbiItem({ abi: marketAbi, name: 'OrderCancelled' }),
  getAbiItem({ abi: marketAbi, name: 'OrderExecuted' }),
  getAbiItem({ abi: marketAbi, name: 'Settled' }),
  getAbiItem({ abi: marketAbi, name: 'Voided' }),
]
const oracleEvents = [getAbiItem({ abi: oracleAbi, name: 'FeedSet' }), getAbiItem({ abi: oracleAbi, name: 'ObservationRecorded' })]

/** Follows market and oracle logs from the deploy block: rolling markets, SL/TP orders, feeds, observations. */
async function scanLogs() {
  const head = await publicClient.getBlockNumber()
  if (scannedTo === undefined) {
    const deploy = process.env.VITE_DEPLOY_BLOCK
    const start = deploy ? BigInt(deploy) : head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n
    scannedTo = start - 1n
    log(`order scan starts at block ${start} (head ${head})${deploy ? '' : ', VITE_DEPLOY_BLOCK unset'}`)
  }
  while (scannedTo < head) {
    const fromBlock: bigint = scannedTo + 1n
    const toBlock = fromBlock + LOG_CHUNK - 1n > head ? head : fromBlock + LOG_CHUNK - 1n
    const [marketLogs, oracleLogs] = await Promise.all([
      publicClient.getLogs({ address: addresses.market, events: marketEvents, fromBlock, toBlock, strict: true }),
      publicClient.getLogs({ address: addresses.oracle, events: oracleEvents, fromBlock, toBlock, strict: true }),
    ])
    for (const l of marketLogs) {
      if (l.eventName === 'MarketCreated') {
        if (rollingCreators.has(l.args.creator.toLowerCase())) rolling.add(l.args.marketId)
      } else if (l.eventName === 'Settled' || l.eventName === 'Voided') {
        rolling.delete(l.args.marketId)
        for (const [k, o] of orders) if (o.marketId === l.args.marketId) orders.delete(k)
      } else {
        // Set, cancel and execute all just mark the order for a look: runOrders reads the live order onchain.
        const a = l.args
        orders.set(key(a.marketId, a.user, a.isUp), { marketId: a.marketId, user: a.user, isUp: a.isUp })
      }
    }
    for (const l of oracleLogs) {
      const id = l.args.assetId
      if (id >= ASSETS.length) continue
      if (l.eventName === 'FeedSet') {
        if (feeds[id]?.toLowerCase() !== l.args.feed.toLowerCase()) log(`${ASSETS[id].key} feed is ${l.args.feed}`)
        feeds[id] = l.args.feed
        lastPush[id] = { price: 0n, at: 0n }
      } else if (l.args.timestamp > lastPoke[id]) lastPoke[id] = l.args.timestamp
    }
    scannedTo = toBlock
  }
}

async function runOrders(now: bigint) {
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
      if (now + CLOSE_BUFFER_S >= BigInt(m.expiry)) continue // trading closed
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
      const call = { address: addresses.market, abi: marketAbi, functionName: 'executeOrder', args: [o.marketId, o.user, o.isUp] } as const
      // executeOrder pokes the oracle; an estimate made just before the 60s observation mark runs out of gas after it
      const gas = await publicClient.estimateContractGas({ ...call, account: walletClient.account })
      await send(await walletClient.writeContract({ ...call, gas: (gas * 5n) / 4n }))
      orders.delete(k)
      log(`executed order market ${o.marketId} ${o.isUp ? 'UP' : 'DOWN'} for ${o.user}`)
    } catch (e) {
      log(`order ${k} failed: ${errMsg(e)}`)
    }
  }
}

log(
  `keeper ${account.address} started on ${NETWORK}, market ${addresses.market}, assets ${enabledAssets.map((a) => a.key).join(' ')}` +
    (KEEPER_COUNT > 1 ? `, instance ${KEEPER_INDEX + 1}/${KEEPER_COUNT}` : ''),
)
// The log scan runs beside the ticks, so a long catch-up from the deploy block never holds up pushes,
// orders or settlement. Rotation needs every rolling market seen: it waits for a scan that reached the head.
let scan: Promise<boolean> | undefined
let scanOk = false
for (;;) {
  try {
    scan ??= scanLogs()
      .then(() => (caughtUp = true), (e) => (log(`log scan failed: ${errMsg(e)}`), false))
      .then((ok) => (scanOk = ok))
      .finally(() => (scan = undefined))
    // chain time, not the host clock: expiry, staleness and the age rule all use block.timestamp
    const now = (await publicClient.getBlock()).timestamp
    const markets = await loadMarkets().catch((e) => (log(`market read failed: ${errMsg(e)}`), undefined))
    if (PUSH_PRICES) await pushPrices(now, markets ?? [])
    await runOrders(now) // right after the push: stops and take-profits are the time-sensitive part
    await pokeOracle(now)
    if (markets) await settleMarkets(now, markets)
    // once caught up, each scan is a chunk or two, so waiting for it keeps rotation exact
    if (markets && caughtUp && (await (scan ?? scanOk))) await rotateMarkets(now, markets)
  } catch (e) {
    log(`tick failed: ${errMsg(e)}`)
  }
  await sleep(TICK_MS)
}
