import { useEffect, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import type { Market, Quote } from '@/lib/contracts'
import { ASSETS } from '@/lib/contracts'
import { localQuote, oracleTooOld } from '@/lib/pricing'
import { edgeQuery, oracleSpotQuery, sigmaQuery, useOracleSpot, usePricingParams, type OracleSpot } from './data'

export { DURATIONS } from './data'
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

const toPricing = (spot: OracleSpot | undefined, sigma: number | undefined, edge: number | undefined): AssetPricing => ({
  spot: spot ? Number(spot.price / 10n ** 9n) / 1e9 : undefined,
  updatedAt: spot?.updatedAt,
  sigma,
  edge,
})

export function useAssetPricing(assetId: number): AssetPricing {
  const { sigma, edge } = usePricingParams(assetId)
  return toPricing(useOracleSpot(assetId), sigma, edge)
}

/** Pricing for every listed asset, by asset id. */
export function useAllPricing(): Map<number, AssetPricing> {
  const spots = useQueries({ queries: ASSETS.map((a) => oracleSpotQuery(a.id)) })
  const sigmas = useQueries({ queries: ASSETS.map((a) => sigmaQuery(a.id)) })
  const edge = useQuery(edgeQuery).data
  return new Map(ASSETS.map((a, i) => [a.id, toPricing(spots[i].data, sigmas[i].data, edge)]))
}

/**
 * Same formula the contract uses, run in the browser. No contract call. With `nowS`, an oracle price too old
 * for the time left quotes no executable prices, like the contract.
 */
export function quoteFor(pricing: AssetPricing | undefined, strike: number | undefined, timeLeft: number, nowS?: number): Quote | undefined {
  if (!pricing || pricing.spot === undefined || pricing.sigma === undefined || pricing.edge === undefined || strike === undefined) return undefined
  const oracleAge = nowS !== undefined && pricing.updatedAt !== undefined ? nowS - pricing.updatedAt : undefined
  return localQuote({ spot: pricing.spot, strike, sigma: pricing.sigma, timeLeft, edge: pricing.edge, oracleAge })
}

/** True while trades would revert on the oracle price: past maxTradeStaleness, or older than a quarter of the time left. */
export function oracleWaiting(updatedAt: number | undefined, nowS: number, timeLeft: number): boolean {
  if (updatedAt === undefined) return false
  const age = nowS - updatedAt
  return age > STALE_AFTER_S || oracleTooOld(age, timeLeft)
}

/**
 * The currently open market for each standard duration of an asset. The keeper's rolling market wins over
 * markets users opened with a custom strike (those stay reachable by typing their strike); the latest
 * expiry wins among equals, so the view moves on to the next rolling market.
 */
export function openByDuration(markets: Market[], assetId: number, nowMs: number): Map<number, Market> {
  const nowS = nowMs / 1000
  const out = new Map<number, Market>()
  for (const m of markets) {
    if (m.assetId !== assetId || m.status !== 0 || m.expiry <= nowS) continue
    const d = m.expiry - m.createdAt
    const prev = out.get(d)
    const rank = Number(!!m.byKeeper) - Number(!!prev?.byKeeper)
    if (!prev || rank > 0 || (rank === 0 && m.expiry > prev.expiry)) out.set(d, m)
  }
  return out
}

/** An open market with exactly this strike and duration that still leaves time to bet, reused instead of opening a duplicate. */
export function findStrikeMarket(markets: Market[], assetId: number, duration: number, strike: bigint, nowS: number, minTimeLeft: number): Market | undefined {
  return markets.find((m) => m.assetId === assetId && m.status === 0 && m.expiry - m.createdAt === duration && m.expiry - nowS > minTimeLeft && m.strike === strike)
}
