import { parseUnits } from 'viem'
import { fmtPrice } from '@/lib/format'

export interface OrderValidation {
  stop: bigint
  takeProfit: bigint
  error?: string
}

function parseLevel(value: string): bigint | 'invalid' {
  const v = value.trim()
  if (v === '') return 0n
  try {
    const n = parseUnits(v.replace(/,/g, ''), 18)
    return n > 0n ? n : 'invalid'
  } catch {
    return 'invalid'
  }
}

/** Mirrors the contract's rules: UP needs stop < spot < take profit, DOWN needs take profit < spot < stop. */
export function validateOrder(isUp: boolean, spot: bigint | undefined, stopStr: string, tpStr: string): OrderValidation {
  const stop = parseLevel(stopStr)
  const tp = parseLevel(tpStr)
  if (stop === 'invalid' || tp === 'invalid') return { stop: 0n, takeProfit: 0n, error: 'Enter valid prices.' }
  if (stop === 0n && tp === 0n) return { stop, takeProfit: tp }
  if (spot === undefined) return { stop, takeProfit: tp, error: 'Waiting for the oracle price.' }
  if (isUp) {
    if (stop !== 0n && stop >= spot) return { stop, takeProfit: tp, error: `Stop loss must be below ${fmtPrice(spot)}.` }
    if (tp !== 0n && tp <= spot) return { stop, takeProfit: tp, error: `Take profit must be above ${fmtPrice(spot)}.` }
  } else {
    if (tp !== 0n && tp >= spot) return { stop, takeProfit: tp, error: `Take profit must be below ${fmtPrice(spot)}.` }
    if (stop !== 0n && stop <= spot) return { stop, takeProfit: tp, error: `Stop loss must be above ${fmtPrice(spot)}.` }
  }
  return { stop, takeProfit: tp }
}

function PriceInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="block space-y-2">
      <span className="text-sm text-dim">{label}</span>
      <div className="relative">
        <span className="num pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-dim">$</span>
        <input className="field pl-8" inputMode="decimal" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </label>
  )
}

interface Props {
  isUp: boolean
  spot: bigint | undefined
  stop: string
  takeProfit: string
  onStop: (v: string) => void
  onTakeProfit: (v: string) => void
  error?: string
}

export function OrderFields({ isUp, spot, stop, takeProfit, onStop, onTakeProfit, error }: Props) {
  const hint = (pct: bigint) => (spot ? fmtPrice((spot * pct) / 100n, 0).replace('$', '') : 'Price')
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <PriceInput label="Stop loss" value={stop} onChange={onStop} placeholder={hint(isUp ? 99n : 101n)} />
        <PriceInput label="Take profit" value={takeProfit} onChange={onTakeProfit} placeholder={hint(isUp ? 101n : 99n)} />
      </div>
      {error && <p className="text-sm text-down">{error}</p>}
    </div>
  )
}
