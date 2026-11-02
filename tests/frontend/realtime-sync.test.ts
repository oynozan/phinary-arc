// Drives the real subscription functions behind useRealtimeSync (src/hooks/useRealtimeSync.ts) with a stubbed
// WebSocket client that records every subscription, then pushes decoded logs into the captured onLogs
// callbacks and checks what lands in the react-query cache.
import '../unit/setup'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, erc20Abi, getAbiItem, parseEventLogs, type Log } from 'viem'
import { MARKET, OTHER, USER, marketLog, tx } from './helpers/logs'
import { stubClient, stubTransport } from './helpers/stub'
import { marketAbi } from '@/lib/abis'
import { USDC_ADDRESS } from '@/lib/contracts'
import { checkSocket, watchReconnects } from '@/lib/realtime'
import { qk } from '@/hooks/data'
import { betsQueryOptions } from '@/hooks/useMarketBets'
import { resyncLive, watchMarketEvents, watchWallet } from '@/hooks/useRealtimeSync'

interface Watcher {
  kind: 'contract' | 'event'
  address?: unknown
  eventName?: string
  event?: { name: string }
  args?: Record<string, unknown>
  onLogs: (logs: unknown[]) => void
}
const watchers: Watcher[] = []
const gate = { wait: undefined as undefined | Promise<void> }
const chain = { head: 1000n, logs: [] as Log[] }
let restore: () => void
beforeAll(() => {
  restore = stubClient({
    getBlockNumber: async () => chain.head,
    getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (gate.wait) await gate.wait
      const raw = chain.logs.filter((l) => l.blockNumber! >= fromBlock && l.blockNumber! <= toBlock)
      return parseEventLogs({ abi: marketAbi, logs: raw, eventName: 'Bought' })
    },
    watchContractEvent: (o: Omit<Watcher, 'kind'>) => {
      watchers.push({ kind: 'contract', ...o })
      return () => undefined
    },
    watchEvent: (o: Omit<Watcher, 'kind'>) => {
      watchers.push({ kind: 'event', ...o })
      return () => undefined
    },
  })
})
afterAll(() => restore())

let qc = new QueryClient()
const stops: (() => void)[] = []

/** Deliver logs to the market-contract watcher, decoded the way viem's watchContractEvent decodes them. */
function pushMarket(logs: Log[]) {
  const w = watchers.find((x) => x.kind === 'contract' && x.eventName === undefined)!
  w.onLogs(parseEventLogs({ abi: marketAbi, logs }))
}

function erc20Log(name: 'Approval' | 'Transfer', a: `0x${string}`, b: `0x${string}`, value: bigint, address: `0x${string}` = USDC_ADDRESS): Log {
  const item = getAbiItem({ abi: erc20Abi, name })
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: name, args: (name === 'Approval' ? { owner: a, spender: b } : { from: a, to: b }) as never })
  return { address, topics, data: encodeAbiParameters([item.inputs[2]], [value]), blockNumber: 5n, logIndex: 0, transactionHash: tx(), blockHash: `0x${'00'.repeat(32)}`, transactionIndex: 0, removed: false } as Log
}

/** Deliver a raw ERC-20 log to every watchEvent subscription whose address, event and indexed-arg filter match it. */
function pushErc20(log: Log) {
  for (const w of watchers.filter((x) => x.kind === 'event' && x.event)) {
    if (w.address !== undefined && String(w.address).toLowerCase() !== log.address.toLowerCase()) continue
    let decoded
    try {
      decoded = decodeEventLog({ abi: [w.event as never], data: log.data, topics: log.topics as never })
    } catch {
      continue
    }
    const args = decoded.args as Record<string, unknown>
    const match = Object.entries(w.args ?? {}).every(([k, v]) => String(args[k]).toLowerCase() === String(v).toLowerCase())
    if (match) w.onLogs([{ ...log, args, eventName: decoded.eventName }])
  }
}

const boughtLog = (marketId: bigint, user: `0x${string}`, block: bigint, h = tx(), logIndex = 0) =>
  marketLog('Bought', { marketId, user, isUp: true, units: 2_000_000n, cost: 1_000_000n, fairPrice: 5n * 10n ** 17n, oraclePrice: 10n ** 18n, timestamp: 1_700_000_000n }, { block, logIndex, tx: h })

beforeEach(() => {
  qc = new QueryClient()
  watchers.length = 0
  chain.logs = []
  chain.head = 1000n
  gate.wait = undefined
  stops.push(watchMarketEvents(qc, () => USER), watchWallet(qc, USER))
})
afterEach(() => {
  stops.splice(0).forEach((s) => s())
})

describe('market events -> cache writes', () => {
  test('a Bought log is appended to that market\'s bets once, even when the same log is delivered twice', () => {
    qc.setQueryData(qk.bets(7n), [])
    qc.setQueryData(qk.bets(8n), [])
    const l = boughtLog(7n, OTHER, 10n)
    pushMarket([l])
    pushMarket([l])
    expect((qc.getQueryData(qk.bets(7n)) as unknown[]).length).toBe(1)
    expect((qc.getQueryData(qk.bets(8n)) as unknown[]).length).toBe(0)
  })

  test('my Settled-market events invalidate markets, my positions, my market list, usdc and history', () => {
    const keys = [qk.markets, [...qk.positions(USER), '1,2', 3], qk.myMarkets(USER), qk.usdc(USER), qk.history(USER), qk.position(3n, USER)]
    for (const k of keys) qc.setQueryData(k, { x: 1 })
    pushMarket([marketLog('Settled', { marketId: 3n, settlePrice: 1n, upWon: true }, { block: 9n, logIndex: 0, tx: tx() })])
    for (const k of keys) expect(qc.getQueryState(k)?.isInvalidated).toBe(true)
  })

  test('another user\'s Bought does not invalidate my position queries', () => {
    qc.setQueryData(qk.position(3n, USER), { x: 1 })
    qc.setQueryData(qk.bets(3n), [])
    pushMarket([boughtLog(3n, OTHER, 9n)])
    expect(qc.getQueryState(qk.position(3n, USER))?.isInvalidated).toBe(false)
  })

  test('MaxStrikeDeviationSet refreshes the strike band', () => {
    qc.setQueryData(qk.strikeDeviation, 10n ** 17n)
    pushMarket([marketLog('MaxStrikeDeviationSet', { oldDeviation: 10n ** 17n, newDeviation: 5n * 10n ** 16n }, { block: 9n, logIndex: 0, tx: tx() })])
    expect(qc.getQueryState(qk.strikeDeviation)?.isInvalidated).toBe(true)
  })

  test('regression: a bet placed while the market\'s bets are still loading is kept', async () => {
    chain.logs = [boughtLog(4n, OTHER, 900n)]
    let release!: () => void
    gate.wait = new Promise<void>((r) => (release = r))
    const opts = betsQueryOptions(4n)
    const fetching = qc.fetchQuery(opts)
    await Promise.resolve()
    // A new bet lands in block 1001 while the initial scan (up to head 1000) is in flight.
    const fresh = boughtLog(4n, USER, 1001n)
    chain.logs.push(fresh)
    pushMarket([fresh])
    release()
    await fetching
    const bets = qc.getQueryData(opts.queryKey) as { user: string }[]
    expect(bets.map((b) => b.user)).toEqual([OTHER, USER])
  })

  test('a bet already inside the scanned range is not doubled by the hold-back', async () => {
    const early = boughtLog(5n, OTHER, 999n)
    chain.logs = [early]
    let release!: () => void
    gate.wait = new Promise<void>((r) => (release = r))
    const opts = betsQueryOptions(5n)
    const fetching = qc.fetchQuery(opts)
    await Promise.resolve()
    pushMarket([early])
    release()
    await fetching
    expect((qc.getQueryData(opts.queryKey) as unknown[]).length).toBe(1)
  })
})

describe('wallet USDC', () => {
  test('a USDC transfer to the wallet refreshes balance', () => {
    qc.setQueryData(qk.usdc(USER), { balance: 0n, allowance: 0n })
    pushErc20(erc20Log('Transfer', OTHER, USER, 5n))
    expect(qc.getQueryState(qk.usdc(USER))?.isInvalidated).toBe(true)
  })

  test('regression: an Approval from the wallet refreshes the cached allowance', () => {
    // BuyForm / VaultPanel decide whether to send approve() from this cached allowance (staleTime: Infinity).
    qc.setQueryData(qk.usdc(USER), { balance: 10_000_000n, allowance: 0n })
    pushErc20(erc20Log('Approval', USER, MARKET, 2n ** 256n - 1n))
    expect(qc.getQueryState(qk.usdc(USER))?.isInvalidated).toBe(true)
  })

  test('a transfer of some other token does not touch the USDC query', () => {
    qc.setQueryData(qk.usdc(USER), { balance: 0n, allowance: 0n })
    pushErc20(erc20Log('Transfer', OTHER, USER, 5n, '0x00000000000000000000000000000000000000cc'))
    expect(qc.getQueryState(qk.usdc(USER))?.isInvalidated).toBe(false)
  })
})

describe('reconnect resync', () => {
  test('regression: after the socket reconnects, every event-fed query refetches (events sent in the gap are lost)', async () => {
    const sockets = [{ readyState: 1 }, { readyState: 3 }, { readyState: 1 }]
    let current = sockets[0]
    const restoreTransport = stubTransport({ getRpcClient: async () => ({ socket: current }) })
    const stop = watchReconnects(() => resyncLive(qc))
    try {
      for (const k of [qk.usdc(USER), qk.bets(4n), qk.positions(USER), qk.markets]) qc.setQueryData(k, [])
      qc.setQueryData(qk.oracleSeries(0), [{ t: 1, p: 1 }])
      await checkSocket() // first open socket
      expect(qc.getQueryState(qk.usdc(USER))?.isInvalidated).toBe(false)
      current = sockets[1] // dropped
      await checkSocket()
      expect(qc.getQueryState(qk.usdc(USER))?.isInvalidated).toBe(false)
      current = sockets[2] // viem reconnected with a new socket
      await checkSocket()
      for (const k of [qk.usdc(USER), qk.bets(4n), qk.positions(USER), qk.markets]) expect(qc.getQueryState(k)?.isInvalidated).toBe(true)
      // The oracle series is built from events only; refetching it would wipe the chart's fallback line.
      expect(qc.getQueryState(qk.oracleSeries(0))?.isInvalidated).toBe(false)
    } finally {
      stop()
      restoreTransport()
    }
  })
})
