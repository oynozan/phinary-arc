/**
 * Test helper: a line-by-line bigint port of BlackScholesLib.binaryUpPrice and
 * PredictionMarket._quote / mulDiv rounding, used as the reference the browser code must match.
 * Solidity signed division truncates toward zero, as does bigint division.
 */
export const WAD = 10n ** 18n
const LN2 = 693147180559945309n
const YEAR = 31_536_000n
const INT_MAX = (1n << 255n) - 1n

export function lnWad(x0: bigint): bigint {
  let x = x0
  if (x <= 0n) throw new Error('LogUndefined')
  let k = 0n
  while (x < WAD) { x *= 2n; k-- }
  while (x >= 2n * WAD) { x /= 2n; k++ }
  const z = ((x - WAD) * WAD) / (x + WAD)
  const z2 = (z * z) / WAD
  let term = z
  let sum = z
  for (let n = 3n; n <= 79n; n += 2n) {
    term = (term * z2) / WAD
    sum += term / n
  }
  return 2n * sum + k * LN2
}

export function expWad(x: bigint): bigint {
  if (x <= -42139678854452767551n) return 0n
  if (x >= 135305999368893231589n) throw new Error('ExpOverflow')
  let k = x / LN2
  let r = x - k * LN2
  if (r > LN2 / 2n) { k++; r -= LN2 }
  if (r < -LN2 / 2n) { k--; r += LN2 }
  let term = WAD
  let sum = WAD
  for (let n = 1n; n <= 24n; n++) {
    term = (term * r) / WAD / n
    sum += term
  }
  if (k < 0n) return sum >> -k
  return sum << k
}

export function isqrt(x: bigint): bigint {
  if (x === 0n) return 0n
  let z = 1n
  let y = x
  for (const [s, zs] of [[128n, 64n], [64n, 32n], [32n, 16n], [16n, 8n], [8n, 4n], [4n, 2n]] as const) {
    if (y >> s !== 0n) { y >>= s; z <<= zs }
  }
  if (y >> 2n !== 0n) z <<= 1n
  for (let i = 0; i < 8; i++) z = (z + x / z) / 2n
  const other = x / z
  return z < other ? z : other
}

export function normCdfWad(x: bigint): bigint {
  if (x <= -8n * WAD) return 0n
  if (x >= 8n * WAD) return WAD
  if (x === 0n) return WAD / 2n
  const negative = x < 0n
  const a = negative ? -x : x
  const t = (WAD * WAD) / (WAD + (231641900000000000n * a) / WAD)
  let p = 1330274429000000000n
  p = -1821255978000000000n + (p * t) / WAD
  p = 1781477937000000000n + (p * t) / WAD
  p = -356563782000000000n + (p * t) / WAD
  p = 319381530000000000n + (p * t) / WAD
  p = (p * t) / WAD
  const density = (398942280401432677n * expWad(-((a * a) / WAD) / 2n)) / WAD
  let tail = (density * p) / WAD
  if (tail < 0n) tail = 0n
  if (tail > WAD) tail = WAD
  return negative ? tail : WAD - tail
}

export function binaryUpPriceWad(spot: bigint, strike: bigint, sigma: bigint, timeSeconds: bigint): bigint {
  if (spot === 0n || strike === 0n || spot > INT_MAX || strike > INT_MAX) throw new Error('InvalidPricingInput')
  if (timeSeconds === 0n || sigma === 0n) return spot > strike ? WAD : 0n
  const t = (timeSeconds * WAD) / YEAR
  const sigmaSqrtT = (sigma * isqrt(t * WAD)) / WAD
  if (sigmaSqrtT === 0n) return spot > strike ? WAD : 0n
  const drift = (((sigma * sigma) / WAD) * t) / WAD / 2n
  const logRatio = lnWad(spot) - lnWad(strike)
  const numerator = logRatio - drift
  const cutoff = sigmaSqrtT * 8n
  if (numerator >= cutoff) return WAD
  if (numerator <= -cutoff) return 0n
  return normCdfWad((numerator * WAD) / sigmaSqrtT)
}

export interface RefQuote { fairUp: bigint; buyUp: bigint; sellUp: bigint; buyDown: bigint; sellDown: bigint }

/** PredictionMarket._quote for an open, unexpired market. */
export function contractQuote(spot: bigint, strike: bigint, sigma: bigint, timeLeft: bigint, edge: bigint): RefQuote {
  let fairUp = binaryUpPriceWad(spot, strike, sigma, timeLeft)
  if (fairUp < 2n * 10n ** 16n) fairUp = 2n * 10n ** 16n
  if (fairUp > 98n * 10n ** 16n) fairUp = 98n * 10n ** 16n
  if (timeLeft <= 15n) return { fairUp, buyUp: 0n, sellUp: 0n, buyDown: 0n, sellDown: 0n }
  const fairDown = WAD - fairUp
  let buyUp = fairUp + edge
  let buyDown = fairDown + edge
  if (buyUp >= 99n * 10n ** 16n) buyUp = 0n
  if (buyDown >= 99n * 10n ** 16n) buyDown = 0n
  const sellPrice = (fair: bigint) => (fair > edge + 10n ** 16n ? fair - edge : 10n ** 16n)
  return { fairUp, buyUp, sellUp: sellPrice(fairUp), buyDown, sellDown: sellPrice(fairDown) }
}

/** OpenZeppelin Math.mulDiv for non-negative inputs. */
export const mulDivFloor = (a: bigint, b: bigint, d: bigint) => (a * b) / d
export const mulDivCeil = (a: bigint, b: bigint, d: bigint) => {
  const p = a * b
  return p / d + (p % d === 0n ? 0n : 1n)
}

/** Deterministic PRNG so fuzz failures reproduce. */
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const toWadExact = (s: string) => {
  const [w, f = ''] = s.split('.')
  return BigInt(w) * WAD + BigInt((f + '0'.repeat(18)).slice(0, 18))
}
