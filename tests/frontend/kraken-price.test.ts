// Kraken xStocks chart feed (src/hooks/useKrakenPrice.ts). The parsers run on messages recorded from
// wss://ws.kraken.com/v2 and https://api.kraken.com/0/public/OHLC (NVDAx/USD, Sunday 2026-11-01); the stream runs
// with a fake WebSocket and captured timers. No network.
import '../unit/setup'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { krakenBookParser, krakenPair, krakenSource, parseKrakenOhlc, streamKraken } from '@/hooks/useKrakenPrice'
import type { Store } from '@/hooks/useCoinbasePrice'

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')
const recorded = fixture('kraken-book-nvdax.jsonl')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as unknown)

const level = (price: number, qty = 1) => ({ price, qty })
const book = (type: 'snapshot' | 'update', bids: { price: number; qty: number }[], asks: { price: number; qty: number }[], symbol = 'NVDAx/USD') => ({
  channel: 'book',
  type,
  data: [{ symbol, bids, asks, checksum: 0, timestamp: '2026-11-01T00:00:00Z' }],
})

describe('parseKrakenOhlc', () => {
  test('recorded 1-minute candles -> points at each candle open, in ms', () => {
    const pts = parseKrakenOhlc(JSON.parse(fixture('kraken-ohlc-nvdax.json')), 'NVDAxUSD')
    expect(pts.length).toBe(9)
    expect(pts[0]).toEqual({ t: 1793517780_000, p: 204.55 })
    expect(pts[4]).toEqual({ t: 1793519940_000, p: 204.85 })
    expect(pts.at(-1)).toEqual({ t: 1793560980_000, p: 204.74 })
  })

  test('an error response, a missing pair or junk rows give nothing instead of a broken line', () => {
    expect(parseKrakenOhlc({ error: ['EQuery:Unknown asset pair'], result: {} }, 'NVDAxUSD')).toEqual([])
    expect(parseKrakenOhlc({ error: [], result: { AAPLxUSD: [] } }, 'NVDAxUSD')).toEqual([])
    expect(parseKrakenOhlc({ error: [], result: { NVDAxUSD: [[1, 'x'], [2, '-1'], [3, '5']] } }, 'NVDAxUSD')).toEqual([{ t: 3000, p: 5 }])
  })

  test('REST pair name from the WebSocket symbol', () => {
    expect(krakenPair('NVDAx/USD')).toBe('NVDAxUSD')
    expect(krakenPair('AAPLx/USD')).toBe('AAPLxUSD')
  })
})

describe('krakenBookParser (book channel mid)', () => {
  test('recorded session: status and subscribe acks are ignored, heartbeats and book messages report the mid', () => {
    const parse = krakenBookParser('NVDAx/USD')
    const out = recorded.map((m) => parse(m))
    expect(out[0]).toBeUndefined() // status
    expect(out[1]).toBeUndefined() // subscribe ack
    const snapshotMid = (204.45218 + 204.46216) / 2
    expect(out[2]!.price).toBeCloseTo(snapshotMid, 9)

    // Reference: replay every level with no depth limit and take best bid / best ask.
    const bids = new Map<number, number>()
    const asks = new Map<number, number>()
    for (const m of recorded as { channel?: string; data?: { bids?: { price: number; qty: number }[]; asks?: { price: number; qty: number }[] }[] }[]) {
      if (m.channel !== 'book') continue
      for (const l of m.data![0].bids ?? []) if (l.qty === 0) bids.delete(l.price); else bids.set(l.price, l.qty)
      for (const l of m.data![0].asks ?? []) if (l.qty === 0) asks.delete(l.price); else asks.set(l.price, l.qty)
    }
    const refMid = (Math.max(...bids.keys()) + Math.min(...asks.keys())) / 2
    expect(out.at(-1)!.price).toBeCloseTo(refMid, 9)
    // Every heartbeat after the snapshot repeats a valid mid, so the line keeps extending on a quiet book.
    recorded.forEach((m, i) => {
      if ((m as { channel?: string }).channel === 'heartbeat' && i > 2) expect(out[i]!.price).toBeGreaterThan(200)
    })
  })

  test('removing the best level moves the mid to the next one', () => {
    const parse = krakenBookParser('NVDAx/USD')
    expect(parse(book('snapshot', [level(100), level(99)], [level(102), level(103)]))).toEqual({ price: 101 })
    expect(parse(book('update', [level(100, 0)], []))).toEqual({ price: 100.5 })
    expect(parse(book('update', [], [level(102, 0)]))).toEqual({ price: 101 })
  })

  test('levels pushed past depth 10 are dropped, so a stale far level never surfaces as the best', () => {
    const parse = krakenBookParser('NVDAx/USD')
    const bids = Array.from({ length: 10 }, (_, i) => level(100 - i)) // 100 .. 91
    parse(book('snapshot', bids, [level(110)]))
    parse(book('update', [level(101)], [])) // 11 levels: 91 falls out of the subscribed depth
    let last: { price?: number } | undefined
    for (let p = 101; p >= 92; p--) last = parse(book('update', [level(p, 0)], []))
    expect(last).toEqual({}) // no bids left, not a mid built on 91
  })

  test('a heartbeat before any book, a one-sided book and a crossed book prove liveness but give no price', () => {
    const parse = krakenBookParser('NVDAx/USD')
    expect(parse({ channel: 'heartbeat' })).toEqual({})
    expect(parse(book('snapshot', [level(100)], []))).toEqual({})
    expect(parse(book('snapshot', [level(101)], [level(100)]))).toEqual({})
  })

  test('another symbol, a snapshot reset and malformed levels', () => {
    const parse = krakenBookParser('NVDAx/USD')
    parse(book('snapshot', [level(100)], [level(102)]))
    expect(parse(book('update', [level(500)], [level(501)], 'AAPLx/USD'))).toBeUndefined()
    expect(parse(book('update', [{ price: Number.NaN, qty: 1 }], []))).toEqual({ price: 101 })
    // A new snapshot (after a resubscribe) replaces the book instead of merging into it.
    expect(parse(book('snapshot', [level(200)], [level(202)]))).toEqual({ price: 201 })
  })
})

class FakeWS {
  static instances: FakeWS[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  closed = false
  constructor(public url: string) {
    FakeWS.instances.push(this)
  }
  send(m: string) {
    this.sent.push(m)
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }
}

let now = 1_700_000_000_000
const intervals: (() => void)[] = []
const timeouts: (() => void)[] = []
const delays: number[] = []
const fetched: string[] = []
const g = globalThis as unknown as Record<string, unknown>
const saved: Record<string, unknown> = {}
const realNow = Date.now
beforeAll(() => {
  for (const k of ['WebSocket', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']) saved[k] = g[k]
  g.WebSocket = FakeWS
  g.fetch = async (url: string) => (fetched.push(url), { ok: true, json: async () => JSON.parse(fixture('kraken-ohlc-nvdax.json')) as unknown })
  g.setInterval = (fn: () => void) => (intervals.push(fn), intervals.length)
  g.clearInterval = () => undefined
  g.setTimeout = (fn: () => void, ms: number) => (timeouts.push(fn), delays.push(ms), timeouts.length)
  g.clearTimeout = () => undefined
  Date.now = () => now
})
afterAll(() => {
  Object.assign(g, saved)
  Date.now = realNow
})

let store: Store
let stop: (() => void) | undefined
const start = (symbol: string) => {
  store = { product: symbol, points: [], status: 'connecting' }
  stop = streamKraken(symbol, (fn) => (store = fn(store)))
}
const send = (ws: FakeWS, msg: unknown) => ws.onmessage?.({ data: JSON.stringify(msg) })

beforeEach(() => {
  stop?.()
  FakeWS.instances = []
  intervals.length = 0
  timeouts.length = 0
  delays.length = 0
  fetched.length = 0
})

describe('streamKraken', () => {
  test('subscribes to the book channel and backfills from 1-minute OHLC', async () => {
    start('NVDAx/USD')
    const ws = FakeWS.instances[0]
    expect(ws.url).toBe('wss://ws.kraken.com/v2')
    ws.onopen?.()
    expect(JSON.parse(ws.sent[0])).toEqual({ method: 'subscribe', params: { channel: 'book', depth: 10, symbol: ['NVDAx/USD'] } })
    expect(fetched[0]).toBe(krakenSource('NVDAx/USD').backfillUrl)
    expect(fetched[0]).toContain('pair=NVDAxUSD&interval=1&asset_class=tokenized_asset')
    await new Promise((r) => (saved.setTimeout as typeof setTimeout)(r, 0))
    expect(store.points.length).toBe(9)
  })

  test('recorded messages stream as at most one point per second', () => {
    start('NVDAx/USD')
    const ws = FakeWS.instances[0]
    ws.onopen?.()
    for (const m of recorded) {
      send(ws, m)
      now += 400
    }
    expect(store.status).toBe('live')
    // 26 messages over ~10.4s; the first two carry no price.
    const live = store.points.filter((p) => p.t >= 1_700_000_000_000)
    expect(live.length).toBeGreaterThanOrEqual(8)
    expect(live.length).toBeLessThanOrEqual(11)
    for (let i = 1; i < live.length; i++) expect(live[i].t - live[i - 1].t).toBeGreaterThanOrEqual(1000)
  })

  test('heartbeats keep a quiet socket alive: the watchdog leaves it alone', () => {
    start('NVDAx/USD')
    const ws = FakeWS.instances[0]
    ws.onopen?.()
    send(ws, recorded[2]) // snapshot
    for (let i = 0; i < 60; i++) {
      now += 1000
      send(ws, { channel: 'heartbeat' })
      if (i % 3 === 0) for (const fn of intervals) fn()
    }
    expect(FakeWS.instances.length).toBe(1)
    expect(ws.closed).toBe(false)
  })

  test('regression: a silent (half-open) socket is closed and replaced, with a fresh book', () => {
    start('AAPLx/USD')
    const ws = FakeWS.instances[0]
    ws.onopen?.()
    send(ws, book('snapshot', [level(344)], [level(346)], 'AAPLx/USD'))
    now += 60_000
    for (const fn of intervals) fn()
    expect(store.status).toBe('down')
    expect(ws.closed).toBe(true)
    for (const fn of timeouts.splice(0)) fn()
    expect(FakeWS.instances.length).toBe(2)
    const fresh = FakeWS.instances[1]
    fresh.onopen?.()
    // Book state belongs to its socket: an update on the new socket before its snapshot has no mid.
    send(fresh, book('update', [level(343)], [], 'AAPLx/USD'))
    expect(store.points.at(-1)!.p).toBe(345)
    now += 1000
    send(fresh, book('snapshot', [level(350)], [level(352)], 'AAPLx/USD'))
    expect(store.status).toBe('live')
    expect(store.points.at(-1)!.p).toBe(351)
    // The abandoned socket can't schedule another connection or write into the feed.
    ws.onclose?.()
    send(ws, book('snapshot', [level(1)], [level(2)], 'AAPLx/USD'))
    expect(timeouts.length).toBe(0)
    expect(store.points.at(-1)!.p).toBe(351)
  })

  test('reconnects with growing backoff after closes', () => {
    start('NVDAx/USD')
    FakeWS.instances[0].close()
    timeouts.shift()!()
    FakeWS.instances[1].close()
    timeouts.shift()!()
    expect(FakeWS.instances.length).toBe(3)
    expect(store.status).toBe('down')
    expect(delays).toEqual([2000, 4000])
  })
})
