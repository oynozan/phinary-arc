// fetchMarkets() (src/hooks/data.ts) reads the newest markets back to the oldest that can still be open (at least
// 60); it feeds openByDuration and the market names. The Positions table must not depend on that window: a win or
// refund stays claimable however old.
import '../unit/setup'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Address } from 'viem'
import { USER } from './helpers/logs'
import { stubClient } from './helpers/stub'
import { KEEPER_ADDRESSES } from '@/lib/contracts'
import { fetchMarkets, fetchMyPositions, scanMyMarketIds } from '@/hooks/data'
import { openByDuration } from '@/hooks/useMarkets'

const MARKET_COUNT = 237n // live testnet value when the hunt ran (see tests/live/live-probe.ts)
const HEAD = 70_000n
const raw = (id: bigint) => ({ assetId: 0, status: id <= 3n ? 1 : 0, upWon: true, createdAt: 1000 + Number(id), expiry: 4600 + Number(id), strike: 10n ** 18n, settlePrice: 0n, upUnits: 0n, downUnits: 0n, totalCost: 0n })
/** The user bought into market 2 (UP won, unclaimed), market 3 (held DOWN, lost) and market 230 (open). */
const myBuys: Record<string, bigint> = { '2': 1_200n, '3': 25_000n, '230': 69_000n }
const keeperCreated = new Set(['236', '237'])
const positions: Record<string, readonly bigint[]> = { '2': [927_885n, 0n, 500_000n, 0n], '3': [0n, 4_000_000n, 0n, 2_000_000n], '230': [3_000_000n, 0n, 1_500_000n, 0n] }
const getLogsCalls: { eventName: string; args: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }[] = []
const marketReads: bigint[] = []

let restore: () => void
beforeAll(() => {
  restore = stubClient({
    getBlockNumber: async () => HEAD,
    readContract: async ({ functionName, args }: { functionName: string; args?: bigint[] }) => {
      if (functionName === 'marketCount') return MARKET_COUNT
      if (functionName === 'getMarketsRange') {
        const [from, count] = args!
        return Array.from({ length: Number(count) }, (_, i) => raw(from + BigInt(i)))
      }
      throw new Error(functionName)
    },
    getContractEvents: async (q: { eventName: string; args: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }) => {
      getLogsCalls.push(q)
      if (q.toBlock - q.fromBlock + 1n > 10_000n) throw new Error('range > 10000')
      if (q.eventName === 'MarketCreated') {
        expect(q.args.creator).toEqual(KEEPER_ADDRESSES)
        return [...keeperCreated].map((id) => ({ args: { marketId: BigInt(id) } }))
      }
      if (q.eventName === 'Bought') {
        expect(String(q.args.user).toLowerCase()).toBe(USER.toLowerCase())
        return Object.entries(myBuys)
          .filter(([, block]) => block >= q.fromBlock && block <= q.toBlock)
          .map(([id]) => ({ args: { marketId: BigInt(id), user: USER } }))
      }
      throw new Error(q.eventName)
    },
    multicall: async ({ contracts }: { contracts: { functionName: string; args: unknown[] }[] }) =>
      contracts.map((c) => {
        const id = String(c.args[0])
        if (c.functionName === 'getMarket') {
          marketReads.push(BigInt(id))
          return raw(BigInt(id))
        }
        if (c.functionName === 'getPosition') return positions[id] ?? [0n, 0n, 0n, 0n]
        if (c.functionName === 'getOrder') return { stopPrice: 0n, takeProfitPrice: 0n }
        throw new Error(c.functionName)
      }),
  })
})
afterAll(() => restore())

describe('fetchMarkets window', () => {
  test('returns ids in order ending at marketCount', async () => {
    const list = await fetchMarkets()
    expect(list.length).toBe(60)
    expect(list.at(-1)!.id).toBe(MARKET_COUNT)
    expect(list.every((m, i) => i === 0 || m.id === list[i - 1].id + 1n)).toBe(true)
  })

  test('tags the keeper\'s markets from MarketCreated logs filtered by creator, in one <= 10k-block call', async () => {
    getLogsCalls.length = 0
    const list = await fetchMarkets()
    expect(list.filter((m) => m.byKeeper).map((m) => m.id)).toEqual([236n, 237n])
    // Later refreshes only scan new blocks (none here).
    expect(getLogsCalls.filter((c) => c.eventName === 'MarketCreated').length).toBe(0)
  })

  test('regression: with 5 assets (85 keeper markets an hour plus custom strikes) the 1h keeper market is found 52 minutes in', async () => {
    // Before, only the newest 60 ids were read, so a 1h market fell out ~42 minutes after opening and BuyForm opened a duplicate.
    const nowS = Math.floor(Date.now() / 1000)
    const start = nowS - 2 * 3600 - 52 * 60 // the latest hourly slot is 52 minutes ago
    const all: ReturnType<typeof raw>[] = []
    const keeper: bigint[] = []
    const hourly = new Map<number, bigint>()
    for (let min = 0; min <= 172; min++) {
      const t = start + min * 60
      for (let asset = 0; asset < 5; asset++) {
        for (const d of [300, 900, 3600]) {
          if (min % (d / 60) !== 0) continue
          all.push({ ...raw(0n), assetId: asset, status: 0, createdAt: t, expiry: t + d })
          keeper.push(BigInt(all.length))
          if (d === 3600) hourly.set(asset, BigInt(all.length))
        }
      }
      if (min % 3 === 0) all.push({ ...raw(0n), assetId: min % 5, status: 0, createdAt: t, expiry: t + 300, strike: 2n * 10n ** 18n }) // a user's custom strike
    }
    const ranges: bigint[][] = []
    const put = stubClient({
      getBlockNumber: async () => 10n ** 9n,
      readContract: async ({ functionName, args }: { functionName: string; args?: bigint[] }) => {
        if (functionName === 'marketCount') return BigInt(all.length)
        if (functionName === 'getMarketsRange') {
          ranges.push(args!)
          const [from, count] = args!
          return all.slice(Number(from) - 1, Number(from - 1n + count))
        }
        throw new Error(functionName)
      },
      getContractEvents: async () => keeper.map((marketId) => ({ args: { marketId } })),
    })
    try {
      const list = await fetchMarkets()
      expect(all.filter((m) => m.createdAt > start + 120 * 60).length).toBeGreaterThan(60) // more than the old window opened since
      for (let asset = 0; asset < 5; asset++) {
        const open = openByDuration(list, asset, nowS * 1000).get(3600)
        expect(open?.id).toBe(hourly.get(asset)!)
        expect(open?.byKeeper).toBe(true)
      }
      expect(list.at(-1)!.id).toBe(BigInt(all.length))
      expect(list[0].createdAt).toBeLessThanOrEqual(nowS - 3600)
      expect(list[0].id).toBeGreaterThan(1n) // paging stops once a page reaches past the longest duration
      expect(ranges.length).toBeLessThan(Math.ceil(all.length / 60))
    } finally {
      put()
    }
  })

  test('regression: a browser clock 290s fast still reaches an open 1h market', async () => {
    // Paging stopped at a page starting 3400s ago by chain time, which a fast clock read as over an hour old.
    const chainS = Math.floor(Date.now() / 1000)
    const all = Array.from({ length: 120 }, (_, i) => {
      const createdAt = i < 60 ? chainS - 3500 : chainS - 3400 + (i - 60) * 50 // id 61 starts the newest page
      return { ...raw(0n), status: 0, createdAt, expiry: createdAt + 3600 }
    })
    const realNow = Date.now
    Date.now = () => (chainS + 290) * 1000
    const put = stubClient({
      readContract: async ({ functionName, args }: { functionName: string; args?: bigint[] }) => {
        if (functionName === 'marketCount') return BigInt(all.length)
        const [from, count] = args!
        return all.slice(Number(from) - 1, Number(from - 1n + count))
      },
    })
    try {
      expect((await fetchMarkets()).some((m) => m.id === 60n)).toBe(true)
    } finally {
      put()
      Date.now = realNow
    }
  })
})

describe('positions beyond the 60-market window', () => {
  test('the wallet\'s markets come from its own Bought logs, scanned in <= 10,000-block ranges from the deploy block', async () => {
    getLogsCalls.length = 0
    const mine = await scanMyMarketIds(USER, undefined)
    expect(mine.ids.map(String).sort()).toEqual(['2', '230', '3'])
    expect(mine.scannedTo).toBe(HEAD)
    const calls = getLogsCalls.filter((c) => c.eventName === 'Bought')
    expect(calls[0].fromBlock).toBe(1n)
    expect(calls.at(-1)!.toBlock).toBe(HEAD)
    for (const c of calls) expect(c.toBlock - c.fromBlock + 1n).toBeLessThanOrEqual(10_000n)
    // Incremental: nothing new to scan at the same head.
    expect(await scanMyMarketIds(USER, mine)).toBe(mine)
  })

  test('regression: a settled market with winnings to claim is listed even once 60 newer markets exist', async () => {
    // Live: the keeper wallet held 927,885 raw USDC claimable in market 2 that the 60-market window could not show.
    const recent = await fetchMarkets()
    const mine = await scanMyMarketIds(USER, undefined)
    const rows = await fetchMyPositions(USER as Address, recent, mine.ids)
    const won = rows.find((r) => r.market.id === 2n)
    expect(won?.market.status).toBe(1)
    expect(won?.position.upUnits).toBe(927_885n)
    expect(rows.map((r) => String(r.market.id)).sort()).toEqual(['2', '230', '3'])
  })

  test('ended markets with nothing to claim are not read again', async () => {
    marketReads.length = 0
    const recent = await fetchMarkets()
    await fetchMyPositions(USER as Address, recent, [2n, 3n])
    // Market 3 (lost) was found finished by the previous fetch; market 2 still has winnings to claim.
    expect(marketReads).toEqual([2n])
  })
})
