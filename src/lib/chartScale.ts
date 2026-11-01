/** Round-number axis ticks for the price chart. */

export interface PriceScale {
  ticks: number[]
  lo: number
  hi: number
  decimals: number
}

const MULTIPLIERS = [1, 2, 2.5, 5, 10]

function decimalsFor(step: number): number {
  for (let d = 0; d <= 4; d++) {
    const scaled = step * 10 ** d
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return d
  }
  return 4
}

/** ~5 evenly stepped ticks (steps of 1, 2, 2.5, 5 x 10^n) that fully contain [min, max]. */
export function priceScale(min: number, max: number, target = 5): PriceScale {
  const range = Math.max(max - min, Math.abs(max) * 0.0005, 1e-6)
  const raw = range / (target - 1)
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = (MULTIPLIERS.map((m) => m * pow).find((s) => s >= raw) ?? pow * 10)
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(8)))
  return { ticks, lo: ticks[0], hi: ticks[ticks.length - 1], decimals: decimalsFor(step) }
}

const STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 240]

/** Clock ticks on round minutes (e.g. 14:05, 14:10) inside [start, end], at most `max` of them. */
export function timeTicks(start: number, end: number, max = 6): number[] {
  const span = end - start
  const stepMin = STEPS_MIN.find((m) => span / (m * 60_000) <= max) ?? 240
  const step = stepMin * 60_000
  const ticks: number[] = []
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) ticks.push(t)
  return ticks
}

export const fmtHHMM = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
