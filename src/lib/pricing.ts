/**
 * Browser-side port of the contract's pricing (BlackScholesLib + PredictionMarket._quote).
 * Used for instant previews with no contract call. The contract stays the final authority
 * at bet time, so previews use floating point and the UI always sends a slippage bound.
 */
import { WAD, type Quote } from './contracts'

const SECONDS_PER_YEAR = 31_536_000
const MIN_FAIR = 0.02
const MAX_FAIR = 0.98
const MAX_BUY = 0.99
const MIN_SELL = 0.01
export const TRADING_CLOSE_S = 15

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, the same approximation the contract uses). */
export function normCdf(x: number): number {
  const ax = Math.min(Math.abs(x), 8)
  const t = 1 / (1 + 0.2316419 * ax)
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const pdf = Math.exp(-0.5 * ax * ax) / Math.sqrt(2 * Math.PI)
  const upper = pdf * poly
  return x >= 0 ? 1 - upper : upper
}

/** Probability that spot ends above strike: N((ln(S/K) - sigma^2 T / 2) / (sigma sqrt(T))), r = 0. */
export function binaryUpPrice(spot: number, strike: number, sigma: number, seconds: number): number {
  if (seconds <= 0 || sigma <= 0) return spot > strike ? 1 : 0
  const years = seconds / SECONDS_PER_YEAR
  const vol = sigma * Math.sqrt(years)
  const d2 = (Math.log(spot / strike) - 0.5 * sigma * sigma * years) / vol
  return normCdf(d2)
}

const toWad = (v: number) => BigInt(Math.round(v * 1e18))

export interface QuoteInput {
  spot: number
  strike: number
  sigma: number
  /** seconds until expiry */
  timeLeft: number
  edge: number
}

export function localQuote({ spot, strike, sigma, timeLeft, edge }: QuoteInput): Quote {
  const fairUp = Math.min(MAX_FAIR, Math.max(MIN_FAIR, binaryUpPrice(spot, strike, sigma, timeLeft)))
  const fairDown = 1 - fairUp
  const closed = timeLeft <= TRADING_CLOSE_S
  const buyUp = closed || fairUp + edge >= MAX_BUY ? 0 : fairUp + edge
  const buyDown = closed || fairDown + edge >= MAX_BUY ? 0 : fairDown + edge
  const sell = (fair: number) => (closed ? 0 : fair > edge + MIN_SELL ? fair - edge : MIN_SELL)
  return {
    fairUp: toWad(fairUp),
    buyUp: toWad(buyUp),
    sellUp: toWad(sell(fairUp)),
    buyDown: toWad(buyDown),
    sellDown: toWad(sell(fairDown)),
    spot: toWad(spot),
    sigma: toWad(sigma),
    timeLeft: BigInt(Math.max(0, Math.floor(timeLeft))),
  }
}

export { WAD }
