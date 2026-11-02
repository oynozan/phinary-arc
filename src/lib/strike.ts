import { parseUnits } from 'viem'
import { WAD } from './contracts'
import { fmtStrike } from './format'

/** The contract's default maxStrikeDeviation (10%), used until the live value loads. */
export const DEFAULT_MAX_STRIKE_DEVIATION = 10n ** 17n

/** maxStrikeDeviation (1e18 = 100%) -> "10%". */
export const fmtDeviation = (dev: bigint) => `${Number((Number(dev) / 1e16).toFixed(2))}%`

/**
 * Checks a typed custom strike the way createMarket does, in integers on the exact oracle price:
 * rejected when |strike - spot| > spot * maxDeviation / 1e18.
 */
export function checkStrike(text: string, spot: bigint | undefined, maxDeviation: bigint): { wad?: bigint; error?: string } {
  const t = text.trim().replace(/,/g, '')
  if (t === '') return { error: 'Enter a strike price.' }
  let wad: bigint
  try {
    wad = parseUnits(t, 18)
  } catch {
    return { error: 'Enter a valid price.' }
  }
  if (wad <= 0n) return { error: 'Enter a valid price.' }
  if (spot !== undefined) {
    const diff = wad > spot ? wad - spot : spot - wad
    if (diff > (spot * maxDeviation) / WAD) return { error: `Strike must be within ${fmtDeviation(maxDeviation)} of ${fmtStrike(spot)}.` }
  }
  return { wad }
}
