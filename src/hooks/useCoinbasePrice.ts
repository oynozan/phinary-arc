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

interface Store {
  product: string
  points: PricePoint[]
  status: FeedStatus
}

const WS_URL = 'wss://ws-feed.exchange.coinbase.com'
const REST_URL = 'https://api.exchange.coinbase.com'
const SILENCE_MS = 15_000
const MAX_POINTS = 4000

/**
 * Smooth live price line from Coinbase's public market data:
 * 1-minute candles backfill the chart, then the WebSocket ticker streams (at most one point per second).
 * Display only. Settlement and SL/TP use the oracle.
 */
export function useCoinbasePrice(product: string) {
  const [store, setStore] = useState<Store>({ product, points: [], status: 'connecting' })

  useEffect(() => {
    let cancelled = false
    let ws: WebSocket | null = null
    let retry = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let lastPush = 0
    let lastMessage = Date.now()

    const update = (fn: (s: Store) => Store) =>
      setStore((prev) => fn(prev.product === product ? prev : { product, points: [], status: 'connecting' }))

    fetch(`${REST_URL}/products/${product}/candles?granularity=60`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`candles ${r.status}`))))
      .then((rows: number[][]) => {
        if (cancelled) return
        // rows: [time, low, high, open, close, volume], newest first
        const candles = rows.map((r) => ({ t: r[0] * 1000, p: r[3] })).sort((a, b) => a.t - b.t)
        update((s) => {
          const firstLive = s.points[0]?.t ?? Infinity
          return { ...s, points: [...candles.filter((c) => c.t < firstLive), ...s.points] }
        })
      })
      .catch(() => undefined)

    const connect = () => {
      if (cancelled) return
      ws = new WebSocket(WS_URL)
      ws.onopen = () => {
        retry = 0
        ws?.send(JSON.stringify({ type: 'subscribe', product_ids: [product], channels: ['ticker'] }))
      }
      ws.onmessage = (e: MessageEvent<string>) => {
        const msg = JSON.parse(e.data) as TickerMessage
        if (msg.type !== 'ticker' || !msg.price) return
        const now = Date.now()
        lastMessage = now
        const p = Number(msg.price)
        const push = now - lastPush >= 1000
        if (push) lastPush = now
        update((s) => ({
          ...s,
          status: 'live',
          points: push ? [...s.points, { t: now, p }].slice(-MAX_POINTS) : s.points,
        }))
      }
      ws.onclose = () => {
        if (cancelled) return
        update((s) => ({ ...s, status: 'down' }))
        retry += 1
        retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retry, 15_000))
      }
      ws.onerror = () => ws?.close()
    }
    connect()

    const watchdog = setInterval(() => {
      if (Date.now() - lastMessage > SILENCE_MS) update((s) => ({ ...s, status: 'down' }))
    }, 3000)

    return () => {
      cancelled = true
      clearInterval(watchdog)
      clearTimeout(retryTimer)
      ws?.close()
    }
  }, [product])

  if (store.product !== product) return { points: [] as PricePoint[], status: 'connecting' as FeedStatus }
  return { points: store.points, status: store.status }
}
