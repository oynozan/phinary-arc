/**
 * Test-only preload for running scripts/keeper.ts and scripts/setup.ts against anvil without
 * editing them. Controlled by a JSON file at $KH_CTL:
 *   { "offsetMs": number,            // added to Date.now() so the keeper clock follows anvil time
 *     "prices": { "BTC-USD": "67000" }, // Coinbase ticker price strings (fetch is stubbed)
 *     "status": { "BTC-USD": 503 },     // optional non-200 status per product
 *     "speed": 10 }                     // setTimeout delays >= 1s are divided by this
 */
import { readFileSync } from 'node:fs'

type Ctl = { offsetMs?: number; prices?: Record<string, string>; status?: Record<string, number>; speed?: number }
const path = process.env.KH_CTL
if (!path) throw new Error('KH_CTL not set')

const realNow = Date.now.bind(Date)
let cache: Ctl = {}
let readAt = 0
function ctl(): Ctl {
  const n = realNow()
  if (n - readAt > 40) {
    try {
      cache = JSON.parse(readFileSync(path!, 'utf8')) as Ctl
    } catch {
      /* keep last good copy (file may be mid-rename) */
    }
    readAt = n
  }
  return cache
}

Date.now = () => realNow() + (ctl().offsetMs ?? 0)

const realSetTimeout = globalThis.setTimeout
// oxlint-disable-next-line typescript/no-explicit-any
;(globalThis as any).setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  const speed = ctl().speed ?? 10
  const d = typeof ms === 'number' && ms >= 1000 ? Math.max(20, Math.floor(ms / speed)) : ms
  return realSetTimeout(fn, d, ...args)
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const m = /api\.exchange\.coinbase\.com\/products\/([^/]+)\/ticker/.exec(url)
  if (m) {
    const product = m[1]
    const c = ctl()
    const status = c.status?.[product]
    if (status && status !== 200) return new Response(JSON.stringify({ message: 'stub error' }), { status })
    const price = c.prices?.[product]
    if (price === undefined) return new Response(JSON.stringify({ message: 'NotFound' }), { status: 404 })
    return new Response(JSON.stringify({ price }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return realFetch(input, init)
}) as typeof fetch
