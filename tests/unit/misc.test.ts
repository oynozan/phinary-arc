import './setup'
import { describe, expect, test } from 'bun:test'
import { sha256, toBytes } from 'viem'
import { gravatarUrl } from '@/lib/gravatar'
import { isTracked, trackMarket } from '@/lib/session'
import { findStrikeMarket, openByDuration, oracleWaiting, quoteFor } from '@/hooks/useMarkets'
import { assetById, assetKey, type Market } from '@/lib/contracts'
import { WAD } from './contractRef'

describe('gravatar', () => {
  test('checksum-insensitive, sha256 of the lowercase address, identicon forced', () => {
    const a = '0x3F04776B2b253abdC3DF386d82Bc182BE674BF7f'
    const url = gravatarUrl(a)
    expect(url).toBe(gravatarUrl(a.toLowerCase()))
    const hash = sha256(toBytes(a.toLowerCase())).slice(2)
    expect(url).toBe(`https://gravatar.com/avatar/${hash}?d=identicon&f=y&s=64`)
    expect(gravatarUrl(a, 128)).toEndWith('&s=128')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('session tracking', () => {
  test('trackMarket is idempotent and isTracked matches by value', () => {
    expect(isTracked(42n)).toBe(false)
    trackMarket(42n)
    trackMarket(42n)
    expect(isTracked(42n)).toBe(true)
    expect(isTracked(43n)).toBe(false)
  })
})

const mk = (p: Partial<Market>): Market => ({
  id: 1n, assetId: 0, status: 0, upWon: false, createdAt: 0, expiry: 300, strike: 100_000n * WAD,
  settlePrice: 0n, upUnits: 0n, downUnits: 0n, totalCost: 0n, ...p,
})

describe('openByDuration (market selection by duration)', () => {
  test('picks the latest open market per duration, ignores expired/settled/other assets', () => {
    const t0 = 1_800_000_000
    const markets = [
      mk({ id: 1n, createdAt: t0 - 300, expiry: t0 }), // expired at now
      mk({ id: 2n, createdAt: t0 - 10, expiry: t0 + 290 }),
      mk({ id: 3n, createdAt: t0 - 100, expiry: t0 + 800 }),
      mk({ id: 4n, createdAt: t0 - 5, expiry: t0 + 295, status: 1 }),
      mk({ id: 5n, assetId: 1, createdAt: t0, expiry: t0 + 300 }),
    ]
    const open = openByDuration(markets, 0, t0 * 1000)
    expect(open.get(300)?.id).toBe(2n)
    expect(open.get(900)?.id).toBe(3n)
    expect(open.size).toBe(2)
  })

  test('regression: a user-created custom-strike market does not replace the rolling keeper market', () => {
    // createMarket is permissionless and BuyForm opens one for any custom strike, 60s later and 9% away here.
    const t0 = 1_800_000_000
    const keeper = mk({ id: 10n, createdAt: t0, expiry: t0 + 300, strike: 100_000n * WAD, byKeeper: true })
    const custom = mk({ id: 11n, createdAt: t0 + 60, expiry: t0 + 360, strike: 109_000n * WAD, byKeeper: false })
    expect(openByDuration([keeper, custom], 0, (t0 + 61) * 1000).get(300)?.id).toBe(keeper.id)
    expect(openByDuration([custom, keeper], 0, (t0 + 61) * 1000).get(300)?.id).toBe(keeper.id)
  })

  test('the view still moves to the next keeper market, and falls back to any open market when the keeper has none', () => {
    const t0 = 1_800_000_000
    const old = mk({ id: 10n, createdAt: t0, expiry: t0 + 300, byKeeper: true })
    const next = mk({ id: 12n, createdAt: t0 + 290, expiry: t0 + 590, byKeeper: true })
    const custom = mk({ id: 11n, createdAt: t0 + 60, expiry: t0 + 360 })
    expect(openByDuration([old, custom, next], 0, (t0 + 291) * 1000).get(300)?.id).toBe(12n)
    expect(openByDuration([custom], 0, (t0 + 61) * 1000).get(300)?.id).toBe(11n)
  })

  test('a custom strike finds its existing market only with the exact strike, duration and enough time left', () => {
    const t0 = 1_800_000_000
    const custom = mk({ id: 11n, createdAt: t0, expiry: t0 + 300, strike: 109_000n * WAD })
    expect(findStrikeMarket([custom], 0, 300, 109_000n * WAD, t0 + 10, 60)?.id).toBe(11n)
    expect(findStrikeMarket([custom], 0, 300, 109_000n * WAD + 1n, t0 + 10, 60)).toBeUndefined()
    expect(findStrikeMarket([custom], 0, 900, 109_000n * WAD, t0 + 10, 60)).toBeUndefined()
    expect(findStrikeMarket([custom], 0, 300, 109_000n * WAD, t0 + 250, 60)).toBeUndefined()
  })

  test('quoteFor returns undefined until all inputs are known', () => {
    expect(quoteFor(undefined, 100, 300)).toBeUndefined() // pricing for an asset this build does not list
    expect(quoteFor({ spot: undefined, updatedAt: 0, sigma: 0.3, edge: 0.02 }, 100, 300)).toBeUndefined()
    expect(quoteFor({ spot: 100, updatedAt: 0, sigma: 0.3, edge: 0.02 }, undefined, 300)).toBeUndefined()
    expect(quoteFor({ spot: 100, updatedAt: 0, sigma: 0.3, edge: 0.02 }, 100, 300)?.buyUp).toBeGreaterThan(0n)
  })
})

describe('oracle freshness (OracleTooOldForExpiry and maxTradeStaleness)', () => {
  const pricing = { spot: 100, updatedAt: 1_000, sigma: 0.3, edge: 0.02 }
  test('quoteFor quotes no executable prices once the oracle is older than a quarter of the time left', () => {
    expect(quoteFor(pricing, 100, 200, 1_050)!.buyUp).toBeGreaterThan(0n) // 50 * 4 = 200, not more
    const old = quoteFor(pricing, 100, 199, 1_050)!
    expect([old.buyUp, old.buyDown, old.sellUp, old.sellDown]).toEqual([0n, 0n, 0n, 0n])
    expect(old.fairUp).toBeGreaterThan(0n)
    expect(quoteFor(pricing, 100, 199)!.buyUp).toBeGreaterThan(0n) // without a clock, no freshness rule
  })
  test('oracleWaiting covers both rules', () => {
    expect(oracleWaiting(1_000, 1_050, 200)).toBe(false)
    expect(oracleWaiting(1_000, 1_050, 199)).toBe(true)
    expect(oracleWaiting(1_000, 1_111, 3_000)).toBe(true) // past STALE_AFTER_S
    expect(oracleWaiting(undefined, 1_050, 10)).toBe(false)
  })
})

describe('unknown asset ids', () => {
  test('a market for an asset this build does not list gets a neutral label instead of crashing', () => {
    expect(assetById(0)?.key).toBe('BTC')
    // NVDA (id 3) has no VITE_FEED_NVDA in the test env, so it is not offered, but its markets keep their name.
    expect(assetById(3)).toBeUndefined()
    expect(assetKey(3)).toBe('NVDA')
    expect(assetKey(9)).toBe('Asset 9')
  })
})
