// Pure pieces of the trade UI checked against the contract's rules (PredictionMarket.sol).
import '../unit/setup'
import { describe, expect, test } from 'bun:test'
import { formatUnits } from 'viem'
import { validateOrder } from '@/components/OrderFields'
import { openByDuration, quoteFor } from '@/hooks/useMarkets'
import { localQuote } from '@/lib/pricing'
import { costOf, unitsForStake, proceedsOf } from '@/lib/format'
import { worstBuyPrice, worstSellPrice, needsApproval } from '@/lib/bet'
import { parseOnchainError } from '@/hooks/useTx'

const WAD = 10n ** 18n

/** PredictionMarket.setOrder's check, verbatim (strict inequalities against the exact oracle spot). */
function contractAcceptsOrder(isUp: boolean, spot: bigint, stop: bigint, tp: bigint): boolean {
  if (stop === 0n && tp === 0n) return false
  if (isUp) return !((stop !== 0n && stop >= spot) || (tp !== 0n && tp <= spot))
  return !((stop !== 0n && stop <= spot) || (tp !== 0n && tp >= spot))
}

/** The float-rounded spot BuyForm / PositionPanel used to validate against: oracle 1e18 -> useAssetPricing float -> localQuote toWad. */
function floatSpot(oraclePrice: bigint): bigint {
  const spot = Number(oraclePrice / 10n ** 9n) / 1e9 // useAssetPricing
  return quoteFor({ spot, sigma: 0.6, edge: 0.02, updatedAt: 0 }, spot, 600)!.spot
}

describe('validateOrder vs setOrder', () => {
  test('mirrors the contract for clearly valid and invalid levels', () => {
    const spot = 100_000n * WAD
    const cases: [boolean, string, string][] = [
      [true, '99000', '101000'],
      [true, '100001', ''],
      [true, '', '99999'],
      [false, '101000', '99000'],
      [false, '99999', ''],
      [false, '', '100001'],
      [true, '100000', ''],
      [false, '', '100000'],
    ]
    for (const [isUp, s, t] of cases) {
      const v = validateOrder(isUp, spot, s, t)
      expect(!v.error).toBe(contractAcceptsOrder(isUp, spot, v.stop, v.takeProfit))
    }
  })

  test('regression: levels at the oracle price are judged exactly like setOrder (the UI now passes the exact oracle price)', () => {
    // Keeper-pushed feed prices have 2 decimals (Coinbase). The float path rounds hundreds of them above the
    // oracle price, which made an UP stop loss at the oracle price pass the UI and revert on chain.
    let floatMismatches = 0
    const mismatches: string[] = []
    for (let cents = 7_774_300n; cents < 7_774_300n + 2000n; cents++) { // $77,743.00 .. $77,762.99
      const oracle = cents * 10n ** 16n // 1e18 scaled, what useOracleSpot holds
      const typed = formatUnits(oracle, 18) // the user types the oracle price shown on screen
      for (const [isUp, s, t] of [[true, typed, ''], [false, '', typed], [true, '', typed], [false, typed, '']] as const) {
        const v = validateOrder(isUp, oracle, s, t)
        if (!v.error !== contractAcceptsOrder(isUp, oracle, v.stop, v.takeProfit)) mismatches.push(`${isUp ? 'UP' : 'DOWN'} ${s || t}`)
      }
      const f = validateOrder(true, floatSpot(oracle), typed, '')
      if (!f.error && !contractAcceptsOrder(true, oracle, f.stop, f.takeProfit)) floatMismatches++
    }
    expect(mismatches).toEqual([])
    expect(floatMismatches).toBeGreaterThan(0) // the old input really did disagree
  })
})

describe('openByDuration', () => {
  const m = (id: bigint, assetId: number, createdAt: number, duration: number, status = 0) => ({
    id, assetId, status, upWon: false, createdAt, expiry: createdAt + duration, strike: WAD, settlePrice: 0n, upUnits: 0n, downUnits: 0n, totalCost: 0n,
  })
  test('picks the latest open market per duration, skipping other assets, expired and settled ones', () => {
    const now = 10_000
    const list = [m(1n, 0, 9_500, 900), m(2n, 0, 9_890, 900), m(3n, 1, 9_950, 900), m(4n, 0, 9_000, 300), m(5n, 0, 9_800, 300, 1), m(6n, 0, 9_000, 3600)]
    const open = openByDuration(list, 0, now * 1000)
    expect(open.get(900)?.id).toBe(2n)
    expect(open.has(300)).toBe(false)
    expect(open.get(3600)?.id).toBe(6n)
  })
  test('a market is gone exactly at expiry (contract: expired at block.timestamp >= expiry)', () => {
    const open = openByDuration([m(1n, 0, 1000, 300)], 0, 1300 * 1000)
    expect(open.size).toBe(0)
  })
})

describe('local quote vs contract rules', () => {
  test('trading closes at timeLeft <= 15 like _requireTrading (block.timestamp + 15 >= expiry)', () => {
    const q15 = localQuote({ spot: 100, strike: 100, sigma: 0.6, timeLeft: 15, edge: 0.02 })
    const q16 = localQuote({ spot: 100, strike: 100, sigma: 0.6, timeLeft: 16, edge: 0.02 })
    expect(q15.buyUp).toBe(0n)
    expect(q16.buyUp > 0n).toBe(true)
  })
  test('buy price at or above 0.99 is not executable', () => {
    const q = localQuote({ spot: 110, strike: 100, sigma: 0.3, timeLeft: 300, edge: 0.02 })
    expect(q.buyUp).toBe(0n) // fair clamps to 0.98, +0.02 = 1.00 >= 0.99
    expect(q.sellDown).toBe(WAD / 100n)
  })
  test('stake -> units -> cost never exceeds the stake (cost rounds up, units round down)', () => {
    for (const price of [WAD / 3n, (WAD * 52n) / 100n, (WAD * 97n) / 100n, 123456789012345678n]) {
      for (const stake of [1n, 999_999n, 5_000_000n, 123_456_789n]) {
        const units = unitsForStake(stake, price)
        expect(costOf(units, price) <= stake).toBe(true)
        expect(proceedsOf(units, price) <= costOf(units, price)).toBe(true)
      }
    }
  })
  test('slippage bounds bracket the current quote', () => {
    const c = { buyUp: (WAD * 55n) / 100n, buyDown: (WAD * 49n) / 100n, sellUp: (WAD * 51n) / 100n, sellDown: (WAD * 45n) / 100n, spot: 100n * WAD, sigma: (WAD * 6n) / 10n, edge: WAD / 50n, timeLeft: 120 }
    expect(worstBuyPrice(c, 100, true) >= c.buyUp).toBe(true)
    expect(worstBuyPrice(c, 100, true) <= WAD).toBe(true)
    expect(worstSellPrice(c, 100, false) <= c.sellDown).toBe(true)
  })
  test('needsApproval treats a missing allowance as "approve"', () => {
    expect(needsApproval(undefined)).toBe(true)
    expect(needsApproval(2n ** 256n - 1n)).toBe(false)
  })
})

describe('parseOnchainError', () => {
  test('maps wallet rejections and unknown errors', () => {
    expect(parseOnchainError(new Error('User rejected the request.'))).toBe('Transaction cancelled.')
    expect(parseOnchainError(new Error('Transaction reverted'))).toBe('Transaction failed. Please try again.')
    expect(parseOnchainError(new Error('execution reverted: OracleTooOldForExpiry()'))).toBe('Waiting for a fresh oracle price. Try again in a moment.')
  })
})
