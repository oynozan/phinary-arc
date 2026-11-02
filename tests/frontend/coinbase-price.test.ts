// Runs streamCoinbase (the effect body of useCoinbasePrice, src/hooks/useCoinbasePrice.ts) with a fake WebSocket
// and captured timers, to check how the feed recovers from a dead connection. The globals are put back after.
import '../unit/setup'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { streamCoinbase, type Store } from '@/hooks/useCoinbasePrice'

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
const g = globalThis as unknown as Record<string, unknown>
const saved: Record<string, unknown> = {}
const realNow = Date.now
beforeAll(() => {
  for (const k of ['WebSocket', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']) saved[k] = g[k]
  g.WebSocket = FakeWS
  g.fetch = async () => ({ ok: true, json: async () => [] })
  g.setInterval = (fn: () => void) => (intervals.push(fn), intervals.length)
  g.clearInterval = () => undefined
  g.setTimeout = (fn: () => void) => (timeouts.push(fn), timeouts.length)
  g.clearTimeout = () => undefined
  Date.now = () => now
})
afterAll(() => {
  Object.assign(g, saved)
  Date.now = realNow
})

let store: Store
let stop: (() => void) | undefined
const start = (product: string) => {
  store = { product, points: [], status: 'connecting' }
  stop = streamCoinbase(product, (fn) => (store = fn(store)))
}
const tick = (ws: FakeWS, price: string) => ws.onmessage?.({ data: JSON.stringify({ type: 'ticker', price }) })

beforeEach(() => {
  stop?.()
  FakeWS.instances = []
  intervals.length = 0
  timeouts.length = 0
})

describe('streamCoinbase', () => {
  test('streams ticker points at most once per second', () => {
    start('BTC-USD')
    const ws = FakeWS.instances[0]
    ws.onopen?.()
    expect(JSON.parse(ws.sent[0]).product_ids).toEqual(['BTC-USD'])
    tick(ws, '100')
    now += 300
    tick(ws, '101')
    now += 800
    tick(ws, '102')
    expect(store.status).toBe('live')
    expect(store.points.map((p) => p.p)).toEqual([100, 102])
  })

  test('reconnects after the socket closes', () => {
    start('ETH-USD')
    FakeWS.instances[0].onopen?.()
    FakeWS.instances[0].close()
    expect(store.status).toBe('down')
    timeouts.shift()!()
    expect(FakeWS.instances.length).toBe(2)
  })

  test('regression: a silent (half-open) socket is replaced, and the feed resumes on the new one', () => {
    start('SOL-USD')
    const ws = FakeWS.instances[0]
    ws.onopen?.()
    tick(ws, '150')
    // The connection goes silent without a close event (sleep/wake, NAT timeout, proxy drop).
    now += 60_000
    for (const fn of intervals) fn()
    expect(store.status).toBe('down')
    for (const fn of timeouts.splice(0)) fn()
    expect({ socketsOpened: FakeWS.instances.length, oldSocketClosed: ws.closed }).toEqual({ socketsOpened: 2, oldSocketClosed: true })
    const fresh = FakeWS.instances[1]
    fresh.onopen?.()
    now += 1_000
    tick(fresh, '151')
    expect(store.status).toBe('live')
    // The abandoned socket can't schedule another connection or write into the feed.
    ws.onclose?.()
    tick(ws, '1')
    expect(timeouts.length).toBe(0)
    expect(store.points.at(-1)!.p).toBe(151)
  })

  test('the watchdog leaves a socket alone while it is still being reconnected', () => {
    start('BTC-USD')
    FakeWS.instances[0].close()
    now += 60_000
    for (const fn of intervals) fn()
    expect(timeouts.length).toBe(1) // only the close-triggered retry
  })
})
