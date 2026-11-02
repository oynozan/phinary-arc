// watchOraclePrices (src/hooks/useRealtimeSync.ts): feed price events -> the oracle spot, the chart's oracle series
// and the contract's sigma, read with each price. Mainnet StreamsFeed contracts emit Chainlink's AnswerUpdated; the already-deployed testnet
// mocks emit PriceSet; newer mocks emit both for the same round. Logs are encoded and decoded with viem the way
// watchEvent delivers them.
import '../unit/setup'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, parseAbiItem, type Address, type Log } from 'viem'
import { stubClient } from './helpers/stub'
import { tx } from './helpers/logs'
import { ASSETS } from '@/lib/contracts'
import { qk, type OracleSpot, type SeriesPoint } from '@/hooks/data'
import { toWad, watchOraclePrices } from '@/hooks/useRealtimeSync'

const answerUpdated = parseAbiItem('event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)')
const priceSet = parseAbiItem('event PriceSet(uint80 indexed roundId, int256 answer, uint256 timestamp)')

interface Watch {
  address: Address[]
  events: { name: string }[]
  onLogs: (logs: unknown[]) => void
}
let watch: Watch | undefined
const decimals = new Map<string, number | Error>()
const decimalReads: string[] = []
/** getVol: the value the contract returns now (1e18), and an optional gate that holds the read. */
const vol = { value: 55n * 10n ** 16n, reads: 0, gate: undefined as Promise<void> | undefined }
let restore: () => void
beforeAll(() => {
  restore = stubClient({
    watchEvent: (o: Watch) => {
      watch = o
      return () => undefined
    },
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (functionName === 'getVol') {
        vol.reads++
        const v = vol.value
        if (vol.gate) await vol.gate
        return v
      }
      if (functionName !== 'decimals') throw new Error(functionName)
      decimalReads.push(address.toLowerCase())
      const d = decimals.get(address.toLowerCase()) ?? 8
      if (d instanceof Error) throw d
      return d
    },
  })
})
afterAll(() => restore())

const BTC = ASSETS.find((a) => a.key === 'BTC')!
const ETH = ASSETS.find((a) => a.key === 'ETH')!
const SOL = ASSETS.find((a) => a.key === 'SOL')!
const base = { blockHash: `0x${'00'.repeat(32)}`, blockNumber: 5n, transactionIndex: 0, removed: false } as const

function answerLog(feed: Address, roundId: bigint, current: bigint, updatedAt: bigint, logIndex = 0): Log {
  const topics = encodeEventTopics({ abi: [answerUpdated], eventName: 'AnswerUpdated', args: { current, roundId } })
  return { ...base, address: feed, topics, data: encodeAbiParameters([{ type: 'uint256' }], [updatedAt]), logIndex, transactionHash: tx() } as unknown as Log
}
function priceSetLog(feed: Address, roundId: bigint, answer: bigint, timestamp: bigint, logIndex = 1): Log {
  const topics = encodeEventTopics({ abi: [priceSet], eventName: 'PriceSet', args: { roundId } })
  return { ...base, address: feed, topics, data: encodeAbiParameters([{ type: 'int256' }, { type: 'uint256' }], [answer, timestamp]), logIndex, transactionHash: tx() } as unknown as Log
}
/** Decode against the subscription's own event list, as viem's watchEvent with `events` does. */
function push(...logs: Log[]) {
  const decoded = logs.map((l) => {
    const d = decodeEventLog({ abi: watch!.events as never, data: l.data, topics: l.topics as never })
    return { ...l, eventName: d.eventName, args: d.args }
  })
  watch!.onLogs(decoded)
}
const settle = () => new Promise((r) => setTimeout(r, 0))

let qc: QueryClient
let stop: () => void
const invalidated: string[] = []
beforeEach(() => {
  stop?.()
  qc = new QueryClient()
  invalidated.length = 0
  decimalReads.length = 0
  vol.reads = 0
  vol.value = 55n * 10n ** 16n
  const orig = qc.invalidateQueries.bind(qc)
  qc.invalidateQueries = ((f?: { queryKey?: readonly unknown[] }) => {
    invalidated.push(JSON.stringify(f?.queryKey))
    return orig(f as never)
  }) as typeof qc.invalidateQueries
  stop = watchOraclePrices(qc)
})

describe('watchOraclePrices', () => {
  test('subscribes to every listed feed with both AnswerUpdated and PriceSet', () => {
    expect(watch!.address).toEqual(ASSETS.map((a) => a.feed))
    expect(watch!.events.map((e) => e.name).sort()).toEqual(['AnswerUpdated', 'PriceSet'])
  })

  test('AnswerUpdated sets the spot (normalized to 1e18) and appends the series', async () => {
    push(answerLog(BTC.feed, 7n, 77_743_79000000n, 1_800_000_000n))
    await settle()
    expect(qc.getQueryData<OracleSpot>(qk.oracle(BTC.id))).toEqual({ price: 77_743_79n * 10n ** 16n, updatedAt: 1_800_000_000 })
    expect(qc.getQueryData<SeriesPoint[]>(qk.oracleSeries(BTC.id))).toEqual([{ t: 1_800_000_000_000, p: 77_743.79 }])
  })

  test('regression: sigma is re-read with every price and lands with it, never a fresh spot with the old sigma', async () => {
    qc.setQueryData(qk.oracle(BTC.id), { price: 1n, updatedAt: 1 })
    qc.setQueryData(qk.sigma(BTC.id), 0.3)
    let open!: () => void
    vol.gate = new Promise<void>((r) => (open = r))
    vol.value = 61n * 10n ** 16n
    push(answerLog(BTC.feed, 8n, 78_000_00000000n, 1_800_000_005n))
    await settle()
    // Sigma read in flight: neither value has moved yet.
    expect(qc.getQueryData(qk.sigma(BTC.id))).toBe(0.3)
    expect(qc.getQueryData<OracleSpot>(qk.oracle(BTC.id))!.price).toBe(1n)
    open()
    vol.gate = undefined
    await settle()
    expect(qc.getQueryData(qk.sigma(BTC.id))).toBe(0.61)
    expect(qc.getQueryData<OracleSpot>(qk.oracle(BTC.id))!.price).toBe(78_000n * 10n ** 18n)
  })

  test('a round whose reads finish after a newer round arrived is dropped; the newer one applies its own sigma', async () => {
    let open!: () => void
    vol.gate = new Promise<void>((r) => (open = r))
    vol.value = 40n * 10n ** 16n
    push(answerLog(BTC.feed, 20n, 70_000_00000000n, 1_800_000_020n))
    await settle()
    vol.gate = undefined
    vol.value = 42n * 10n ** 16n
    push(answerLog(BTC.feed, 21n, 70_100_00000000n, 1_800_000_021n))
    await settle()
    open()
    await settle()
    expect(qc.getQueryData(qk.sigma(BTC.id))).toBe(0.42)
    expect(qc.getQueryData<OracleSpot>(qk.oracle(BTC.id))!.price).toBe(70_100n * 10n ** 18n)
    expect(qc.getQueryData<SeriesPoint[]>(qk.oracleSeries(BTC.id))).toHaveLength(1)
  })

  test('regression: a mock emitting both events for one round applies it once', async () => {
    push(answerLog(ETH.feed, 3n, 2_500_00000000n, 1_800_000_010n), priceSetLog(ETH.feed, 3n, 2_500_00000000n, 1_800_000_010n))
    await settle()
    expect(qc.getQueryData<SeriesPoint[]>(qk.oracleSeries(ETH.id))).toHaveLength(1)
    expect(vol.reads).toBe(1)
  })

  test('an older-deployed mock (PriceSet only) still updates, and a late older round never overwrites a newer one', async () => {
    push(priceSetLog(SOL.feed, 10n, 150_25000000n, 1_800_000_100n))
    push(priceSetLog(SOL.feed, 9n, 149_00000000n, 1_800_000_090n))
    await settle()
    expect(qc.getQueryData<OracleSpot>(qk.oracle(SOL.id))!.price).toBe(150_25n * 10n ** 16n)
    expect(qc.getQueryData<SeriesPoint[]>(qk.oracleSeries(SOL.id))).toHaveLength(1)
  })

  test('feed decimals are read once per feed and respected (an 18-decimal feed is not scaled up)', async () => {
    decimals.set(SOL.feed.toLowerCase(), 18)
    push(answerLog(SOL.feed, 1n, 151n * 10n ** 18n, 1_800_000_200n), answerLog(SOL.feed, 2n, 152n * 10n ** 18n, 1_800_000_201n))
    await settle()
    decimals.delete(SOL.feed.toLowerCase())
    expect(decimalReads.filter((a) => a === SOL.feed.toLowerCase())).toHaveLength(1)
    expect(qc.getQueryData<OracleSpot>(qk.oracle(SOL.id))!.price).toBe(152n * 10n ** 18n)
    expect(toWad(77_743_79000000n, 8)).toBe(77_743_790000000000000000n)
    expect(toWad(123n * 10n ** 20n, 20)).toBe(123n * 10n ** 18n)
  })

  test('non-positive answers and unknown feeds are ignored', async () => {
    push(answerLog(BTC.feed, 1n, 0n, 1_800_000_300n), answerLog(BTC.feed, 2n, -5n, 1_800_000_301n))
    push(answerLog('0x000000000000000000000000000000000000dEaD', 1n, 100n, 1_800_000_302n))
    await settle()
    expect(qc.getQueryData(qk.oracle(BTC.id))).toBeUndefined()
    expect(invalidated).toHaveLength(0)
    expect(vol.reads).toBe(0)
  })
})

describe('watchOraclePrices: decimals read failure', () => {
  test('falls back to refetching spot and sigma, and retries the decimals read on the next update', async () => {
    decimals.set(ETH.feed.toLowerCase(), new Error('rpc down'))
    push(answerLog(ETH.feed, 50n, 2_600_00000000n, 1_800_000_400n))
    await settle()
    expect(invalidated).toContain(JSON.stringify(qk.oracle(ETH.id)))
    expect(invalidated).toContain(JSON.stringify(qk.sigma(ETH.id)))
    expect(qc.getQueryData(qk.oracle(ETH.id))).toBeUndefined()
    decimals.delete(ETH.feed.toLowerCase())
    push(answerLog(ETH.feed, 51n, 2_601_00000000n, 1_800_000_401n))
    await settle()
    expect(qc.getQueryData<OracleSpot>(qk.oracle(ETH.id))!.price).toBe(2_601n * 10n ** 18n)
  })
})
