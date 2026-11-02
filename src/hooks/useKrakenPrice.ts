import { streamPrices, usePriceStream, type PricePoint, type PriceSource, type Store } from './useCoinbasePrice'

const DEPTH = 10

interface Level {
  price: number
  qty: number
}

interface BookMessage {
  channel?: string
  type?: string
  data?: { symbol?: string; bids?: Level[]; asks?: Level[] }[]
}

/** Kraken's REST pair name for a WebSocket symbol: "NVDAx/USD" -> "NVDAxUSD". */
export const krakenPair = (symbol: string) => symbol.replace('/', '')

/** OHLC rows [time, open, high, low, close, vwap, volume, count] for one pair -> points at each candle's open. */
export function parseKrakenOhlc(json: unknown, pair: string): PricePoint[] {
  const res = json as { error?: unknown[]; result?: Record<string, unknown> }
  const rows = res.error?.length ? undefined : res.result?.[pair]
  if (!Array.isArray(rows)) return []
  return (rows as unknown[][]).map((r) => ({ t: Number(r[0]) * 1000, p: Number(r[1]) })).filter((x) => Number.isFinite(x.t) && Number.isFinite(x.p) && x.p > 0)
}

/** One side of the book: apply levels (qty 0 removes one), then keep the best `DEPTH`, as Kraken's v2 book spec says. */
function applySide(side: Map<number, number>, levels: Level[] | undefined, bids: boolean) {
  for (const l of levels ?? []) {
    if (!Number.isFinite(l.price) || !Number.isFinite(l.qty)) continue
    if (l.qty === 0) side.delete(l.price)
    else side.set(l.price, l.qty)
  }
  if (side.size <= DEPTH) return
  const keep = [...side.keys()].sort((a, b) => (bids ? b - a : a - b)).slice(0, DEPTH)
  for (const p of [...side.keys()]) if (!keep.includes(p)) side.delete(p)
}

/**
 * Parser for the v2 `book` channel of one symbol: keeps the book and reports the mid of best bid and ask.
 * Heartbeats (about one a second while subscribed) prove the socket alive and repeat the current mid, so a
 * quiet book (weekends) still extends the line. A crossed or one-sided book has no mid.
 */
export function krakenBookParser(symbol: string) {
  const bids = new Map<number, number>()
  const asks = new Map<number, number>()
  const mid = (): { price?: number } => {
    if (bids.size === 0 || asks.size === 0) return {}
    const bid = Math.max(...bids.keys())
    const ask = Math.min(...asks.keys())
    return bid > 0 && ask > bid ? { price: (bid + ask) / 2 } : {}
  }
  return (msg: unknown): { price?: number } | undefined => {
    const m = msg as BookMessage
    if (m.channel === 'heartbeat') return mid()
    if (m.channel !== 'book' || (m.type !== 'snapshot' && m.type !== 'update')) return undefined
    const d = m.data?.find((x) => x.symbol === symbol)
    if (!d) return undefined
    if (m.type === 'snapshot') {
      bids.clear()
      asks.clear()
    }
    applySide(bids, d.bids, true)
    applySide(asks, d.asks, false)
    return mid()
  }
}

export const krakenSource = (symbol: string): PriceSource => ({
  wsUrl: 'wss://ws.kraken.com/v2',
  subscribe: JSON.stringify({ method: 'subscribe', params: { channel: 'book', depth: DEPTH, symbol: [symbol] } }),
  backfillUrl: `https://api.kraken.com/0/public/OHLC?pair=${krakenPair(symbol)}&interval=1&asset_class=tokenized_asset`,
  parseBackfill: (json) => parseKrakenOhlc(json, krakenPair(symbol)),
  parser: () => krakenBookParser(symbol),
})

export const streamKraken = (symbol: string, update: (fn: (s: Store) => Store) => void) => streamPrices(krakenSource(symbol), update)

/**
 * Live stock line from Kraken's xStocks market (keyless, around the clock): 1-minute candles backfill, then
 * the order book mid over the WebSocket (at most one point per second). Display only; settlement uses the oracle.
 */
export const useKrakenPrice = (symbol: string | undefined) => usePriceStream(symbol, streamKraken)
