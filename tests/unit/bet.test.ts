import './setup'
import { describe, expect, test } from 'bun:test'
import { maxUint256 } from 'viem'
import { chainFromQuote, GAS_RESERVE, MIN_SPOT_MOVE, needsApproval, sizeBuy, spendable, spotMove, worstBuyPrice, worstSellPrice, type ChainQuote } from '@/lib/bet'
import { localQuote } from '@/lib/pricing'
import { costOf, proceedsOf, unitsForStake } from '@/lib/format'
import { parseUsdc } from '@/onchain-money'
import { contractQuote, mulDivCeil, mulDivFloor, WAD } from './contractRef'

// Live Arc Testnet parameters read on 2026-11-01 (tests/unit/live-quote-check.ts): edge 0.02,
// sigma BTC 0.3, ETH 0.4, SOL 0.5. The keeper used to push on a 5 bps move (now 2 bps, and every change near expiry), so 5 bps stays the bar.
const EDGE = 2n * 10n ** 16n
const SIGMA: Record<string, bigint> = { BTC: 3n * 10n ** 17n, ETH: 4n * 10n ** 17n, SOL: 5n * 10n ** 17n }

function chainAt(spot: bigint, strike: bigint, sigma: bigint, timeLeft: number, edge = EDGE): ChainQuote {
  const q = contractQuote(spot, strike, sigma, BigInt(timeLeft), edge)
  return { buyUp: q.buyUp, buyDown: q.buyDown, sellUp: q.sellUp, sellDown: q.sellDown, spot, sigma, edge, timeLeft }
}
/** Move spot by b basis points (tenths allowed). */
const bps = (spot: bigint, b: number) => (spot * BigInt(Math.round((10_000 + b) * 10))) / 100_000n
const strikeNum = (k: bigint) => Number(k) / 1e18

describe('worstBuyPrice / worstSellPrice basic bounds', () => {
  const spot = 77_000n * WAD
  test('never below the current buy price and never above 1', () => {
    for (const k of [0.95, 0.99, 1, 1.01, 1.05]) {
      const strike = (spot * BigInt(Math.round(k * 1e4))) / 10_000n
      for (const t of [61, 120, 300, 900, 3600]) {
        const c = chainAt(spot, strike, SIGMA.BTC, t)
        for (const isUp of [true, false]) {
          const cur = isUp ? c.buyUp : c.buyDown
          if (cur === 0n) continue
          const w = worstBuyPrice(c, strikeNum(strike), isUp)
          expect(w).toBeGreaterThanOrEqual(cur)
          expect(w).toBeLessThanOrEqual(WAD)
          const s = worstSellPrice(c, strikeNum(strike), isUp)
          expect(s).toBeLessThanOrEqual(isUp ? c.sellUp : c.sellDown)
          expect(s).toBeGreaterThan(0n)
        }
      }
    }
  })

  test('covers pure time decay over the 45s drift window (spot unchanged)', () => {
    for (const k of [0.995, 0.999, 1, 1.001, 1.005]) {
      const strike = (spot * BigInt(Math.round(k * 1e4))) / 10_000n
      for (const t of [61, 300, 900, 3600]) {
        const c = chainAt(spot, strike, SIGMA.BTC, t)
        for (const isUp of [true, false]) {
          const cur = isUp ? c.buyUp : c.buyDown
          if (cur === 0n) continue
          const units = unitsForStake(parseUsdc('25'), cur)
          const maxCost = costOf(units, worstBuyPrice(c, strikeNum(strike), isUp))
          const minProceeds = proceedsOf(units, worstSellPrice(c, strikeNum(strike), isUp))
          for (let dt = 0; dt <= 45; dt++) {
            if (t - dt <= 15) break
            const later = contractQuote(spot, strike, SIGMA.BTC, BigInt(t - dt), EDGE)
            const p = isUp ? later.buyUp : later.buyDown
            if (p !== 0n) expect(mulDivCeil(units, p, WAD)).toBeLessThanOrEqual(maxCost)
            const sp = isUp ? later.sellUp : later.sellDown
            expect(mulDivFloor(units, sp, WAD)).toBeGreaterThanOrEqual(minProceeds)
          }
        }
      }
    }
  })
})

describe('slippage bound vs one oracle tick', () => {
  /** Smallest adverse spot move (in bps) that pushes the contract price past the UI's maxCost. */
  function revertThresholdBps(asset: string, duration: number, elapsed: number, isUp: boolean) {
    const spot = 100_000n * WAD
    const strike = spot // keeper markets are created at spot
    const c = chainAt(spot, strike, SIGMA[asset], duration - elapsed)
    const cur = isUp ? c.buyUp : c.buyDown
    const units = unitsForStake(parseUsdc('10'), cur)
    const maxCost = costOf(units, worstBuyPrice(c, strikeNum(strike), isUp))
    for (let b = 0; b <= 500; b++) {
      const moved = bps(spot, isUp ? b / 10 : -b / 10)
      const later = contractQuote(moved, strike, SIGMA[asset], BigInt(duration - elapsed - 15), EDGE)
      const p = isUp ? later.buyUp : later.buyDown
      if (p === 0n || mulDivCeil(units, p, WAD) > maxCost) return b / 10
    }
    return Infinity
  }

  test('table: adverse move (bps) that makes a $10 bet revert with SlippageExceeded, 15s after quoting', () => {
    const rows: string[] = []
    for (const asset of ['BTC', 'ETH', 'SOL'])
      for (const d of [300, 900, 3600]) rows.push(`${asset} ${d / 60}m market, bet 30s in: UP reverts at +${revertThresholdBps(asset, d, 30, true)} bps, DOWN at -${revertThresholdBps(asset, d, 30, false)} bps`)
    console.log(rows.join('\n'))
    expect(rows.length).toBe(9)
  })

  // The keeper pushes a new oracle price on a 5 bps move (or a 45s heartbeat), so a push often lands while
  // the wallet confirms. The bound must survive at least that move on every asset and duration.
  test('regression: a bet survives an adverse oracle push of the keeper threshold (5 bps) while the wallet confirms', () => {
    for (const asset of ['BTC', 'ETH', 'SOL'])
      for (const d of [300, 900, 3600])
        for (const isUp of [true, false]) expect(revertThresholdBps(asset, d, 30, isUp)).toBeGreaterThanOrEqual(5)
  })

  test('regression: a 5m BTC sell survives a 5 bps adverse oracle push', () => {
    const spot = 100_000n * WAD
    const c = chainAt(spot, spot, SIGMA.BTC, 270)
    const units = 20_000_000n
    const minProceeds = proceedsOf(units, worstSellPrice(c, strikeNum(spot), true))
    let threshold = Infinity
    for (let b = 0; b <= 500; b++) {
      const later = contractQuote(bps(spot, -b / 10), spot, SIGMA.BTC, 255n, EDGE)
      if (mulDivFloor(units, later.sellUp, WAD) < minProceeds) { threshold = b / 10; break }
    }
    expect(threshold).toBeGreaterThanOrEqual(5)
  })

  test('the buy bound never exceeds 0.99, the highest price the contract sells at', () => {
    const spot = 100_000n * WAD
    for (const t of [61, 300, 3600]) {
      const c = chainAt(spot, (spot * 999n) / 1000n, SIGMA.SOL, t)
      expect(worstBuyPrice(c, strikeNum((spot * 999n) / 1000n), true)).toBeLessThanOrEqual((WAD * 99n) / 100n)
    }
  })

  test('a side that is not executable gets no bound (the caller refuses to trade it)', () => {
    const c = chainAt(100_000n * WAD, 100_000n * WAD, SIGMA.BTC, 300)
    expect(worstBuyPrice({ ...c, buyUp: 0n }, 100_000, true)).toBe(0n)
    expect(worstSellPrice({ ...c, sellUp: 0n, sellDown: 0n }, 100_000, false)).toBe(0n)
  })

  test('chainFromQuote gives the same bounds as the contract quote it mirrors', () => {
    const q = localQuote({ spot: 100_000, strike: 100_000, sigma: 0.3, timeLeft: 300, edge: 0.02 })
    const c = chainFromQuote(q, 0.02)
    expect(c.edge).toBe(EDGE)
    expect(c.timeLeft).toBe(300)
    const ref = chainAt(100_000n * WAD, 100_000n * WAD, SIGMA.BTC, 300)
    const diff = worstBuyPrice(c, 100_000, true) - worstBuyPrice(ref, 100_000, true)
    expect(diff < 0n ? -diff : diff).toBeLessThan(10n ** 10n)
  })
})

describe('sizeBuy (BuyForm stake -> units and max cost)', () => {
  const spot = 100_000n * WAD
  const c = chainAt(spot, spot, SIGMA.BTC, 3000)
  const current = c.buyUp
  const worst = worstBuyPrice(c, strikeNum(spot), true)

  test('with enough balance it buys the full stake at the current price, bounded by the worst price', () => {
    const stake = parseUsdc('10')
    const { units, maxCost } = sizeBuy(stake, current, worst, parseUsdc('1000'))
    expect(units).toBe(unitsForStake(stake, current))
    expect(maxCost).toBe(costOf(units, worst))
    expect(sizeBuy(stake, current, worst, undefined)).toEqual({ units, maxCost })
  })

  test('regression: near the balance it keeps the typed size and caps only the bound at the balance less the gas reserve', () => {
    const stake = parseUsdc('60')
    const balance = parseUsdc('61')
    const { units, maxCost } = sizeBuy(stake, current, worst, balance)
    expect(units).toBe(unitsForStake(stake, current))
    expect(maxCost).toBe(balance - GAS_RESERVE)
    expect(maxCost).toBeLessThan(costOf(units, worst))
    // Still a real bound: the bet goes through on any move the balance covers, and costs at least the price now.
    expect(maxCost).toBeGreaterThan(costOf(units, current))
  })

  test('regression: a large bet on a short at-the-money market is not shrunk (it used to buy about half)', () => {
    const short = chainAt(spot, spot, SIGMA.SOL, 120)
    const cur = short.buyUp
    const w = worstBuyPrice(short, strikeNum(spot), true)
    expect(Number(w) / Number(cur)).toBeGreaterThan(1.3) // the worst case is far above the price on a 2-minute ATM market
    const balance = parseUsdc('500')
    const stake = spendable(balance) // Balance button
    const { units, maxCost } = sizeBuy(stake, cur, w, balance)
    expect(units).toBe(unitsForStake(stake, cur))
    expect(maxCost).toBe(stake)
    expect(costOf(units, cur)).toBeLessThanOrEqual(stake)
  })

  test('regression: Arc pays gas from the USDC balance, so the bound never spends the last 0.05 USDC', () => {
    expect(GAS_RESERVE).toBe(parseUsdc('0.05'))
    const balance = parseUsdc('100')
    const { units, maxCost } = sizeBuy(balance, current, worst, balance) // the whole balance typed in
    expect(maxCost).toBe(balance - GAS_RESERVE)
    expect(spendable(GAS_RESERVE)).toBe(0n)
    expect(sizeBuy(parseUsdc('1'), current, worst, GAS_RESERVE).maxCost).toBe(0n)
    expect(maxCost).toBeLessThan(costOf(units, current)) // so the form refuses the whole balance
  })

  test('a stake the wallet cannot cover at the current price gives a bound below the cost (the form refuses it)', () => {
    const { units, maxCost } = sizeBuy(parseUsdc('100'), current, worst, parseUsdc('50'))
    expect(maxCost).toBeLessThan(costOf(units, current))
  })
})

describe('spotMove (oracle move allowed while the wallet confirms)', () => {
  // Default vols from the oracle config: BTC 0.55, ETH 0.75, SOL 0.95, NVDA 0.50, AAPL 0.30; AAPL floor 0.15.
  test('at every default vol 2 sigma over 45s is well above the 2 bps keeper push threshold, so the floor does not bind', () => {
    for (const sigma of [0.55, 0.75, 0.95, 0.5, 0.3]) {
      expect(spotMove(sigma)).toBeGreaterThan(MIN_SPOT_MOVE)
      expect(spotMove(sigma)).toBeGreaterThan(3 * 0.0002)
    }
    expect(spotMove(0.3)).toBeCloseTo(0.000717, 5)
  })

  test('the 5 bps floor binds only near the calmest vol bound, and stays 2.5x the 2 bps push threshold', () => {
    expect(spotMove(0.15)).toBe(MIN_SPOT_MOVE)
    expect(MIN_SPOT_MOVE / 0.0002).toBe(2.5)
  })

  test('a $10 AAPL bet at its vol floor survives a 2.5-push (5 bps) adverse oracle move while the wallet confirms', () => {
    const s = 344n * WAD
    const sigma = 15n * 10n ** 16n
    for (const t of [300, 900, 3600]) {
      const ch = chainAt(s, s, sigma, t - 30)
      for (const isUp of [true, false]) {
        const cur = isUp ? ch.buyUp : ch.buyDown
        const units = unitsForStake(parseUsdc('10'), cur)
        const maxCost = costOf(units, worstBuyPrice(ch, strikeNum(s), isUp))
        const later = contractQuote(bps(s, isUp ? 5 : -5), s, sigma, BigInt(t - 45), EDGE)
        expect(mulDivCeil(units, isUp ? later.buyUp : later.buyDown, WAD)).toBeLessThanOrEqual(maxCost)
      }
    }
  })
})

describe('approval', () => {
  test('needsApproval', () => {
    expect(needsApproval(undefined)).toBe(true)
    expect(needsApproval(0n)).toBe(true)
    expect(needsApproval(10n ** 12n)).toBe(true)
    expect(needsApproval(maxUint256)).toBe(false)
    expect(needsApproval(maxUint256 / 2n)).toBe(false)
  })
})
