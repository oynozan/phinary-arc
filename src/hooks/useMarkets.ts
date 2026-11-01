import { useEffect, useState } from 'react'
import type { Market, Quote } from '@/lib/contracts'
import { ASSETS } from '@/lib/contracts'
import { localQuote } from '@/lib/pricing'
import { useOracleSpot, usePricingParams } from './data'

export const DURATIONS = [300, 900, 3600] as const
/** The contract rejects trades on a price older than this (maxTradeStaleness default is 120s). */
export const STALE_AFTER_S = 110

/** Wall clock in ms, ticking once a second. Drives countdowns and time-decay in previews. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export interface AssetPricing {
  /** oracle price in USD (what settlement uses) */
  spot: number | undefined
  updatedAt: number | undefined
  sigma: number | undefined
  edge: number | undefined
}

export function useAssetPricing(assetId: number): AssetPricing {
  const spot = useOracleSpot(assetId)
  const { sigma, edge } = usePricingParams(assetId)
  return {
    spot: spot ? Number(spot.price / 10n ** 9n) / 1e9 : undefined,
    updatedAt: spot?.updatedAt,
    sigma,
    edge,
  }
}

/** Pricing for all three assets (fixed count, so hook order is stable). */
export function useAllPricing(): AssetPricing[] {
  const a = useAssetPricing(ASSETS[0].id)
  const b = useAssetPricing(ASSETS[1].id)
  const c = useAssetPricing(ASSETS[2].id)
  return [a, b, c]
}

/** Same formula the contract uses, run in the browser. No contract call. */
export function quoteFor(pricing: AssetPricing, strike: number | undefined, timeLeft: number): Quote | undefined {
  if (pricing.spot === undefined || pricing.sigma === undefined || pricing.edge === undefined || strike === undefined) return undefined
  return localQuote({ spot: pricing.spot, strike, sigma: pricing.sigma, timeLeft, edge: pricing.edge })
}

/** The currently open market for each standard duration of an asset. */
export function openByDuration(markets: Market[], assetId: number, nowMs: number): Map<number, Market> {
  const nowS = nowMs / 1000
  const out = new Map<number, Market>()
  for (const m of markets) {
    if (m.assetId !== assetId || m.status !== 0 || m.expiry <= nowS) continue
    const d = m.expiry - m.createdAt
    const prev = out.get(d)
    if (!prev || m.expiry > prev.expiry) out.set(d, m)
  }
  return out
}
