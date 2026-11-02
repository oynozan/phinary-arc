import './setup'
import { describe, expect, test } from 'bun:test'
import { binaryUpPrice, localQuote, normCdf, oracleTooOld, TRADING_CLOSE_S } from '@/lib/pricing'
import { TRADING_CLOSE_BUFFER_S } from '@/lib/contracts'
import { contractQuote, rng, WAD } from './contractRef'

const E = 1e18
const wad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n // 6dp exact inputs

// Reference CDF via erf (W. J. Cody style high precision is overkill; use a 1e-12 series).
function erf(x: number): number {
  // Abramowitz-Stegun 7.1.26 is too coarse; integrate with Simpson for a reference.
  const n = 4000
  const h = x / n
  let s = 0
  for (let i = 0; i <= n; i++) {
    const w = i === 0 || i === n ? 1 : i % 2 ? 4 : 2
    s += w * Math.exp(-((i * h) ** 2))
  }
  return ((2 / Math.sqrt(Math.PI)) * s * h) / 3
}
const refCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2))

describe('normCdf', () => {
  test('matches the true normal CDF within the A&S 26.2.17 bound (7.5e-8)', () => {
    for (let x = -6; x <= 6; x += 0.05) expect(Math.abs(normCdf(x) - refCdf(x))).toBeLessThan(1e-7)
  })
  test('is symmetric and monotonic, 0.5 at 0', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 8) // contract special-cases x == 0 to exactly 0.5; A&S gives 0.5 + 5e-10
    let prev = -1
    for (let x = -10; x <= 10; x += 0.01) {
      const v = normCdf(x)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-15)
      expect(normCdf(-x) + v).toBeCloseTo(1, 7)
      prev = v
    }
  })
  test('handles infinities', () => {
    expect(normCdf(Infinity)).toBeCloseTo(1, 12)
    expect(normCdf(-Infinity)).toBeCloseTo(0, 12)
  })
})

describe('binaryUpPrice', () => {
  test('deterministic limits: no time or no vol', () => {
    expect(binaryUpPrice(101, 100, 0.5, 0)).toBe(1)
    expect(binaryUpPrice(100, 100, 0.5, 0)).toBe(0) // tie resolves DOWN
    expect(binaryUpPrice(99, 100, 0, 600)).toBe(0)
  })
  test('ATM price is just under 0.5 (negative drift term)', () => {
    const p = binaryUpPrice(100, 100, 0.5, 3600)
    expect(p).toBeLessThan(0.5)
    expect(p).toBeGreaterThan(0.498)
  })
  test('monotonic: higher spot -> higher UP price', () => {
    let prev = 0
    for (let s = 90; s <= 110; s += 0.5) {
      const p = binaryUpPrice(s, 100, 0.6, 900)
      expect(p).toBeGreaterThanOrEqual(prev)
      prev = p
    }
  })
})

describe('localQuote vs contract _quote (bigint port of BlackScholesLib)', () => {
  test('fuzz: prices agree within 1e-9 and executability (zero vs non-zero) always agrees', () => {
    const r = rng(1)
    const edges = [0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.05]
    let worst = 0
    const mismatches: string[] = []
    for (let i = 0; i < 3000; i++) {
      const spot = 1 + r() * 120_000
      const strike = spot * (0.9 + r() * 0.2)
      const sigma = 0.05 + r() * 1.95
      const timeLeft = Math.floor(1 + r() * 3600)
      const edge = edges[i % edges.length]
      const sW = wad(spot), kW = wad(strike), vW = wad(sigma), eW = wad(edge)
      const s = Number(sW) / E, k = Number(kW) / E, v = Number(vW) / E, e = Number(eW) / E
      const local = localQuote({ spot: s, strike: k, sigma: v, timeLeft, edge: e })
      const ref = contractQuote(sW, kW, vW, BigInt(timeLeft), eW)
      for (const key of ['fairUp', 'buyUp', 'sellUp', 'buyDown', 'sellDown'] as const) {
        const a = local[key], b = ref[key]
        if ((a === 0n) !== (b === 0n)) mismatches.push(`${key} local=${a} ref=${b} spot=${s} strike=${k} sigma=${v} t=${timeLeft} edge=${e}`)
        else worst = Math.max(worst, Math.abs(Number(a - b)) / E)
      }
    }
    expect(mismatches).toEqual([])
    expect(worst).toBeLessThan(1e-9)
  })

  test('deep in-the-money side with edge 0.01: 0.98 + 0.01 is treated as >= 0.99 like the contract', () => {
    // fairUp clamps to MIN_FAIR 0.02, so fairDown = 0.98 and buyDown = 0.98 + edge.
    // Contract: 0.99e18 >= 0.99e18 -> buyDown = 0 (BuyPriceTooHigh). The float port computes 0.98 + 0.01 = 0.9899999999999999.
    const local = localQuote({ spot: 90, strike: 100, sigma: 0.3, timeLeft: 600, edge: 0.01 })
    const ref = contractQuote(90n * WAD, 100n * WAD, 3n * 10n ** 17n, 600n, 10n ** 16n)
    expect(ref.buyDown).toBe(0n)
    expect(local.buyDown).toBe(ref.buyDown)
  })

  test('close buffer: <= 15s left quotes no executable prices, 16s does', () => {
    expect(TRADING_CLOSE_S).toBe(TRADING_CLOSE_BUFFER_S)
    const q15 = localQuote({ spot: 100, strike: 100, sigma: 0.5, timeLeft: 15, edge: 0.02 })
    expect([q15.buyUp, q15.buyDown, q15.sellUp, q15.sellDown]).toEqual([0n, 0n, 0n, 0n])
    expect(q15.fairUp).toBeGreaterThan(0n)
    const q16 = localQuote({ spot: 100, strike: 100, sigma: 0.5, timeLeft: 16, edge: 0.02 })
    expect(q16.buyUp).toBeGreaterThan(0n)
    expect(q16.sellDown).toBeGreaterThan(0n)
  })

  test('fair clamps to [0.02, 0.98], buys >= 0.99 become 0, sells floor at 0.01', () => {
    const deep = localQuote({ spot: 120, strike: 100, sigma: 0.2, timeLeft: 60, edge: 0.02 })
    expect(deep.fairUp).toBe(BigInt(Math.round(0.98 * 1e18)))
    expect(deep.buyUp).toBe(0n)
    expect(deep.sellDown).toBe(BigInt(Math.round(0.01 * 1e18)))
    expect(deep.buyDown).toBeGreaterThan(0n)
  })

  test('timeLeft is floored and never negative', () => {
    expect(localQuote({ spot: 100, strike: 100, sigma: 0.5, timeLeft: 99.9, edge: 0.02 }).timeLeft).toBe(99n)
    expect(localQuote({ spot: 100, strike: 100, sigma: 0.5, timeLeft: -5, edge: 0.02 }).timeLeft).toBe(0n)
  })

  test('spot is encoded to 1e18 with no gross error for large prices', () => {
    const q = localQuote({ spot: 77743.79, strike: 77743.79, sigma: 0.3, timeLeft: 300, edge: 0.02 })
    expect(Math.abs(Number(q.spot - 77743_790000000000000000n))).toBeLessThan(1e7)
  })
})

describe('oracle age (OracleTooOldForExpiry)', () => {
  test('mirrors (now - updatedAt) * 4 > timeLeft: no executable prices, fair still quoted', () => {
    expect(oracleTooOld(25, 100)).toBe(false)
    expect(oracleTooOld(25.01, 100)).toBe(true)
    const ok = localQuote({ spot: 100, strike: 100, sigma: 0.5, timeLeft: 100, edge: 0.02, oracleAge: 25 })
    expect(ok.buyUp).toBeGreaterThan(0n)
    const old = localQuote({ spot: 100, strike: 100, sigma: 0.5, timeLeft: 100, edge: 0.02, oracleAge: 26 })
    expect([old.buyUp, old.buyDown, old.sellUp, old.sellDown]).toEqual([0n, 0n, 0n, 0n])
    expect(old.fairUp).toBe(ok.fairUp)
    expect(old.timeLeft).toBe(100n)
  })
})
