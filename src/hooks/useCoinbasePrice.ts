import { useEffect, useState } from 'react'

export interface PricePoint {
  t: number
  p: number
}

export type FeedStatus = 'connecting' | 'live' | 'down'

interface TickerMessage {
  type?: string
  price?: string
}

export interface Store {
  product: string
  points: PricePoint[]
  status: FeedStatus
}

/**
 * One exchange's public market data. `parser()` makes a fresh message parser per socket (a book feed keeps
 * state). It returns undefined for messages to ignore, and otherwise proves the socket alive, with the
 * current price when there is one.
 */
export interface PriceSource {
  wsUrl: string
  subscribe: string
  backfillUrl: string
  parseBackfill: (json: unknown) => PricePoint[]
  parser: () => (msg: unknown) => { price?: number } | undefined
}

const SILENCE_MS = 15_000
const MAX_POINTS = 4000

/**
 * Streams one source into `update`: 1-minute candles backfill, then the WebSocket. Returns the cleanup.
 * A socket that goes silent without closing (sleep/wake, NAT or proxy timeout) is replaced.
 */
export function streamPrices(source: PriceSource, update: (fn: (s: Store) => Store) => void): () => void {
  let cancelled = false
  let ws: WebSocket | null = null
  let retry = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let lastPush = 0
  let lastMessage = Date.now()

  fetch(source.backfillUrl)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`candles ${r.status}`))))
    .then((json: unknown) => {
      if (cancelled) return
      const candles = source.parseBackfill(json).sort((a, b) => a.t - b.t)
      update((s) => {
        const firstLive = s.points[0]?.t ?? Infinity
        return { ...s, points: [...candles.filter((c) => c.t < firstLive), ...s.points] }
      })
    })
    .catch(() => undefined)

  const reconnect = () => {
    update((s) => ({ ...s, status: 'down' }))
    retry += 1
    retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retry, 15_000))
  }

  const connect = () => {
    if (cancelled) return
    const sock = new WebSocket(source.wsUrl)
    const parse = source.parser()
    ws = sock
    sock.onopen = () => {
      retry = 0
      lastMessage = Date.now()
      sock.send(source.subscribe)
    }
    sock.onmessage = (e: MessageEvent<string>) => {
      if (sock !== ws) return
      let parsed: { price?: number } | undefined
      try {
        parsed = parse(JSON.parse(e.data))
      } catch {
        return
      }
      if (!parsed) return
      const now = Date.now()
      lastMessage = now
      const p = parsed.price
      const push = p !== undefined && now - lastPush >= 1000
      if (push) lastPush = now
      update((s) => ({
        ...s,
        status: 'live',
        points: push ? [...s.points, { t: now, p }].slice(-MAX_POINTS) : s.points,
      }))
    }
    sock.onclose = () => {
      // A replaced socket closing late must not schedule a second connection.
      if (cancelled || sock !== ws) return
      ws = null
      reconnect()
    }
    sock.onerror = () => sock.close()
  }
  connect()

  const watchdog = setInterval(() => {
    if (Date.now() - lastMessage <= SILENCE_MS || !ws) return
    // Silent but not closed: drop it ourselves, since on a half-open link the close event may never come.
    const dead = ws
    ws = null
    dead.onopen = dead.onmessage = dead.onclose = dead.onerror = null
    dead.close()
    lastMessage = Date.now()
    reconnect()
  }, 3000)

  return () => {
    cancelled = true
    clearInterval(watchdog)
    clearTimeout(retryTimer)
    ws?.close()
  }
}

export const coinbaseSource = (product: string): PriceSource => ({
  wsUrl: 'wss://ws-feed.exchange.coinbase.com',
  subscribe: JSON.stringify({ type: 'subscribe', product_ids: [product], channels: ['ticker'] }),
  backfillUrl: `https://api.exchange.coinbase.com/products/${product}/candles?granularity=60`,
  // rows: [time, low, high, open, close, volume], newest first
  parseBackfill: (rows) => (rows as number[][]).map((r) => ({ t: r[0] * 1000, p: r[3] })),
  parser: () => (msg) => {
    const m = msg as TickerMessage
    if (m.type !== 'ticker' || !m.price) return undefined
    const p = Number(m.price)
    return Number.isFinite(p) && p > 0 ? { price: p } : undefined
  },
})

export const streamCoinbase = (product: string, update: (fn: (s: Store) => Store) => void) => streamPrices(coinbaseSource(product), update)

/** Live line for `key` from `stream`, or an idle feed while `key` is undefined (so callers can route without breaking hook order). */
export function usePriceStream(key: string | undefined, stream: (key: string, update: (fn: (s: Store) => Store) => void) => () => void) {
  const [store, setStore] = useState<Store>({ product: key ?? '', points: [], status: 'connecting' })

  useEffect(() => {
    if (key === undefined) return
    return stream(key, (fn) => setStore((prev) => fn(prev.product === key ? prev : { product: key, points: [], status: 'connecting' })))
  }, [key, stream])

  if (key === undefined || store.product !== key) return { points: [] as PricePoint[], status: 'connecting' as FeedStatus }
  return { points: store.points, status: store.status }
}

/**
 * Smooth live price line from Coinbase's public market data:
 * 1-minute candles backfill the chart, then the WebSocket ticker streams (at most one point per second).
 * Display only. Settlement and SL/TP use the oracle.
 */
export const useCoinbasePrice = (product: string | undefined) => usePriceStream(product, streamCoinbase)
