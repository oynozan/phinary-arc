// Runs loadHistory (the queryFn of useHistory in src/hooks/history.ts) against a scripted fake RPC, keeping the
// "cache" the way react-query would: the result of a successful run is the next run's `prev`.
import '../unit/setup'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Log } from 'viem'
import { OTHER, USER, marketLog, tx } from './helpers/logs'
import { stubClient } from './helpers/stub'
import { loadHistory, type HistoryData } from '@/hooks/history'

/** Fake chain: logs by block, a head, and optional failures. */
const chain = { head: 0n, logs: [] as Log[], failFrom: undefined as bigint | undefined, failBlocks: false, getLogsCalls: [] as [bigint, bigint][] }
let restore: () => void
beforeAll(() => {
  restore = stubClient({
    getBlockNumber: async () => chain.head,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      if (chain.failBlocks) throw new Error('rate limited')
      return { timestamp: 1_700_000_000n + blockNumber }
    },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      chain.getLogsCalls.push([fromBlock, toBlock])
      if (toBlock - fromBlock + 1n > 10_000n) throw new Error('RPC Request failed. (range > 10000)')
      if (chain.failFrom !== undefined && toBlock >= chain.failFrom) throw new Error('RPC Request failed.')
      return chain.logs.filter((l) => l.blockNumber! >= fromBlock && l.blockNumber! <= toBlock)
    },
  })
})
afterAll(() => restore())

let cached: HistoryData | undefined
/** One refresh of the history query: only a successful run replaces the cached data. */
async function refresh(): Promise<HistoryData> {
  const data = await loadHistory(USER, cached)
  cached = data
  return data
}

const bought = (marketId: bigint, isUp: boolean, units: bigint, cost: bigint, block: bigint, user = USER) =>
  marketLog('Bought', { marketId, user, isUp, units, cost, fairPrice: 5n * 10n ** 17n, oraclePrice: 10n ** 18n, timestamp: 1n }, { block, logIndex: 0, tx: tx() })

/** executeOrder emits Sold (from _sellPosition) and then OrderExecuted in the same transaction. */
function orderExecuted(marketId: bigint, isUp: boolean, units: bigint, proceeds: bigint, block: bigint): Log[] {
  const h = tx()
  return [
    marketLog('Sold', { marketId, user: USER, isUp, units, proceeds, fairPrice: 1n, oraclePrice: 1n, timestamp: 1n }, { block, logIndex: 0, tx: h }),
    marketLog('OrderExecuted', { marketId, user: USER, isUp, units, proceeds, spot: 1n, triggered: 1 }, { block, logIndex: 1, tx: h }),
  ]
}
const settled = (marketId: bigint, upWon: boolean, block: bigint) => marketLog('Settled', { marketId, settlePrice: 1n, upWon }, { block, logIndex: 0, tx: tx() })

beforeEach(() => {
  cached = undefined
  chain.head = 0n
  chain.logs = []
  chain.failFrom = undefined
  chain.failBlocks = false
  chain.getLogsCalls = []
})

describe('loadHistory', () => {
  test('scans from the deploy block in <= 10,000-block getLogs ranges (Arc RPC limit)', async () => {
    chain.head = 35_000n
    chain.logs = [bought(1n, true, 10_000_000n, 5_000_000n, 2n), bought(1n, true, 1n, 1n, 34_999n, OTHER)]
    const d = await refresh()
    expect(d.items.map((i) => i.kind)).toEqual(['bought'])
    for (const [a, b] of chain.getLogsCalls) expect(b - a + 1n).toBeLessThanOrEqual(10_000n)
    expect(chain.getLogsCalls[0][0]).toBe(1n)
    expect(chain.getLogsCalls.at(-1)![1]).toBe(35_000n)
  })

  test('incremental refresh only scans new blocks and does not duplicate rows', async () => {
    chain.head = 100n
    chain.logs = [bought(1n, true, 10n, 5n, 50n)]
    await refresh()
    chain.logs.push(bought(1n, false, 3n, 1n, 150n))
    chain.head = 200n
    chain.getLogsCalls = []
    const d = await refresh()
    expect(chain.getLogsCalls).toEqual([[101n, 200n]])
    expect(d.items.filter((i) => i.kind === 'bought').length).toBe(2)
  })

  test('settled row: winner payout equals winning units held', async () => {
    chain.head = 100n
    chain.logs = [bought(7n, true, 10_000_000n, 5_000_000n, 10n), bought(7n, false, 2_000_000n, 1_000_000n, 11n), settled(7n, true, 90n)]
    const d = await refresh()
    const row = d.items.find((i) => i.kind === 'settled')!
    expect(row.result).toBe('won')
    expect(row.amount).toBe(10_000_000n)
  })

  test('regression: an executed stop loss is subtracted once from net units, so the settled result is right', async () => {
    // Buy 10 UP, the stop loss sells all 10, buy 15 UP again, UP wins: the user is paid 15.
    chain.head = 100n
    chain.logs = [bought(3n, true, 10_000_000n, 5_000_000n, 10n), ...orderExecuted(3n, true, 10_000_000n, 2_000_000n, 20n), bought(3n, true, 15_000_000n, 7_000_000n, 30n), settled(3n, true, 90n)]
    const d = await refresh()
    expect(d.net.get('3')!.up).toBe(15_000_000n)
    const row = d.items.find((i) => i.kind === 'settled')
    expect(row?.result).toBe('won')
    expect(row?.amount).toBe(15_000_000n)
  })

  test('regression: an executed stop loss shows as one "Stop loss hit" row, not also a "Sold" row', async () => {
    chain.head = 100n
    chain.logs = [bought(3n, true, 10_000_000n, 5_000_000n, 10n), ...orderExecuted(3n, true, 10_000_000n, 2_000_000n, 20n)]
    const d = await refresh()
    const exits = d.items.filter((i) => i.kind === 'sold' || i.kind === 'order-hit')
    expect(exits.map((i) => [i.kind, i.trigger, i.amount])).toEqual([['order-hit', 1, 2_000_000n]])
    expect(d.net.get('3')!.up).toBe(0n)
  })

  test('a plain sell in another transaction is still its own row', async () => {
    chain.head = 100n
    const sold = marketLog('Sold', { marketId: 3n, user: USER, isUp: true, units: 4_000_000n, proceeds: 1n, fairPrice: 1n, oraclePrice: 1n, timestamp: 1n }, { block: 15n, logIndex: 0, tx: tx() })
    chain.logs = [bought(3n, true, 10_000_000n, 5_000_000n, 10n), sold, ...orderExecuted(3n, true, 6_000_000n, 2_000_000n, 20n)]
    const d = await refresh()
    expect(d.items.filter((i) => i.kind === 'sold' || i.kind === 'order-hit').map((i) => i.kind)).toEqual(['sold', 'order-hit'])
    expect(d.net.get('3')!.up).toBe(0n)
  })

  test('regression: a refresh that fails part-way leaves the cached net units alone, and the retry counts once', async () => {
    chain.head = 100n
    chain.logs = [bought(5n, true, 10_000_000n, 5_000_000n, 10n)]
    await refresh()
    expect(cached!.net.get('5')!.up).toBe(10_000_000n)

    // New activity in the first chunk of the next scan; the second chunk's getLogs fails (RPC hiccup).
    chain.logs.push(bought(5n, true, 4_000_000n, 2_000_000n, 200n))
    chain.head = 15_000n
    chain.failFrom = 10_101n
    await expect(refresh()).rejects.toThrow()
    const cachedAfterFailure = cached!.net.get('5')!.up

    // react-query retries; the RPC is fine again.
    chain.failFrom = undefined
    chain.logs.push(settled(5n, true, 14_000n))
    const d = await refresh()
    const row = d.items.find((i) => i.kind === 'settled')!
    expect({ cachedAfterFailure, payoutShown: row.amount }).toEqual({ cachedAfterFailure: 10_000_000n, payoutShown: 14_000_000n })
  })

  test('regression: a block-time lookup failing after the logs were processed does not double-count either', async () => {
    chain.head = 100n
    chain.logs = [bought(5n, true, 10_000_000n, 5_000_000n, 10n)]
    await refresh()
    chain.logs.push(bought(5n, true, 4_000_000n, 2_000_000n, 177n)) // a block whose time is not cached yet
    chain.head = 200n
    chain.failBlocks = true
    await expect(refresh()).rejects.toThrow()
    expect(cached!.net.get('5')!.up).toBe(10_000_000n)
    chain.failBlocks = false
    expect((await refresh()).net.get('5')!.up).toBe(14_000_000n)
  })
})
