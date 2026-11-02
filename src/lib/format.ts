import { formatUnits } from 'viem'
import { formatUnitsFixed, parseUsdc } from '@/onchain-money'
import { USDC_DECIMALS, WAD } from './contracts'

/** 1e18 fixed point -> number (display only, never for money math). */
export const wadToNumber = (v: bigint) => Number(formatUnits(v, 18))

/** Underlying price -> "$77,743.79". */
export function fmtPrice(v: bigint | number, digits = 2): string {
  const n = typeof v === 'bigint' ? wadToNumber(v) : v
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** Decimals for a strike or order level: cents at every price from $1 (settlement compares exact prices), 4 below. */
export const priceDigits = (n: number) => (Math.abs(n) >= 1 ? 2 : 4)

/** Strike or stop/take-profit level -> "$150.40", "$77,743.79". */
export function fmtStrike(v: bigint | number): string {
  const n = typeof v === 'bigint' ? wadToNumber(v) : v
  return fmtPrice(n, priceDigits(n))
}

/** A typed USDC amount -> raw units. Empty, invalid, zero or negative input reads as 0. */
export function parseUsdcInput(v: string): bigint {
  try {
    const raw = v.trim() === '' ? 0n : parseUsdc(v)
    return raw > 0n ? raw : 0n
  } catch {
    return 0n
  }
}

/** USDC raw (6 decimals) -> "12.34". */
export function fmtUsdc(raw: bigint, digits = 2): string {
  return Number(formatUnitsFixed(raw, USDC_DECIMALS, digits)).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** Price of a $1 payout (1e18 fraction) -> "52¢". The same number is the implied probability. */
export const fmtCents = (v: bigint) => `${Math.round(wadToNumber(v) * 100)}¢`

export const shortAddr = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`

export function fmtCountdown(seconds: number): string {
  if (seconds <= 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function fmtDurationLong(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? '1 hour' : `${seconds / 3600} hours`
  return `${Math.round(seconds / 60)} min`
}

export function fmtDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  return `${Math.round(seconds / 60)}m`
}

export const fmtClock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

export const fmtDeadline = (ms: number) =>
  new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

/** Units to buy for a USDC stake at a 1e18 unit price (rounds down). */
export const unitsForStake = (stakeRaw: bigint, price: bigint) => (price === 0n ? 0n : (stakeRaw * WAD) / price)

/** Cost of units at a price, rounded up (mirrors the contract). */
export const costOf = (units: bigint, price: bigint) => (units * price + WAD - 1n) / WAD

/** Proceeds of selling units at a price, rounded down (mirrors the contract). */
export const proceedsOf = (units: bigint, price: bigint) => (units * price) / WAD
