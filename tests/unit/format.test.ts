import './setup'
import { describe, expect, test } from 'bun:test'
import { costOf, fmtCents, fmtCountdown, fmtDuration, fmtDurationLong, fmtPrice, fmtStrike, fmtUsdc, proceedsOf, shortAddr, unitsForStake, wadToNumber } from '@/lib/format'
import { mulDivCeil, mulDivFloor, rng, WAD } from './contractRef'

const randBig = (r: () => number, max: bigint) => (BigInt(Math.floor(r() * 2 ** 52)) * max) / 2n ** 52n

describe('cost / proceeds / units match the contract rounding', () => {
  test('fuzz: costOf == mulDiv(Ceil), proceedsOf == mulDiv(Floor)', () => {
    const r = rng(7)
    for (let i = 0; i < 20000; i++) {
      const units = randBig(r, 10n ** 15n) + (i % 3 === 0 ? 0n : 1n)
      const price = randBig(r, WAD)
      expect(costOf(units, price)).toBe(mulDivCeil(units, price, WAD))
      expect(proceedsOf(units, price)).toBe(mulDivFloor(units, price, WAD))
    }
  })

  test('fuzz: units from a USDC stake never cost more than the stake, and waste less than one unit price', () => {
    const r = rng(11)
    for (let i = 0; i < 20000; i++) {
      const stake = randBig(r, 10n ** 12n) + 1n // up to 1M USDC
      const price = 10n ** 16n + randBig(r, 98n * 10n ** 16n) // 0.01 .. 0.99
      const units = unitsForStake(stake, price)
      const cost = costOf(units, price)
      expect(cost).toBeLessThanOrEqual(stake)
      // Buying one more unit would exceed the stake.
      expect(costOf(units + 1n, price)).toBeGreaterThan(stake - 1n)
      expect(units).toBeGreaterThanOrEqual(stake) // price < 1 => payout >= stake
    }
  })

  test('zero price yields zero units (no divide by zero)', () => {
    expect(unitsForStake(5_000_000n, 0n)).toBe(0n)
  })

  test('cost rounding is in the vault\'s favour on dust trades', () => {
    expect(costOf(1n, 1n)).toBe(1n)
    expect(proceedsOf(1n, WAD - 1n)).toBe(0n)
  })
})

describe('fmtUsdc', () => {
  test('basic, tiny and huge values', () => {
    expect(fmtUsdc(0n)).toBe('0.00')
    expect(fmtUsdc(12_340_000n)).toBe('12.34')
    expect(fmtUsdc(1n, 6)).toBe('0.000001')
    expect(fmtUsdc(1_234_567_890_120_000n)).toBe('1,234,567,890.12')
  })

  test('"You pay" equals the typed stake exactly for any executable price (< 1)', () => {
    // units = floor(S*WAD/p) => units*p/WAD lies in (S-1, S] raw units, so the ceiling is exactly S.
    const r = rng(3)
    for (let i = 0; i < 20000; i++) {
      const stake = randBig(r, 10n ** 10n) + 1n
      const price = 10n ** 16n + randBig(r, 98n * 10n ** 16n)
      expect(costOf(unitsForStake(stake, price), price)).toBe(stake)
    }
  })

  test('display truncates (never overstates a payout)', () => {
    expect(fmtUsdc(4_999_999n)).toBe('4.99')
  })

  test('negative raw values', () => {
    expect(fmtUsdc(-12_345_678n)).toBe('-12.34')
  })
})

describe('fmtCents / wadToNumber / fmtPrice', () => {
  test('cents', () => {
    expect(fmtCents(52n * 10n ** 16n)).toBe('52¢')
    expect(fmtCents(10n ** 16n)).toBe('1¢')
    expect(fmtCents(0n)).toBe('0¢')
    expect(fmtCents(985n * 10n ** 15n)).toBe('99¢')
  })
  test('wadToNumber', () => {
    expect(wadToNumber(77743_790000000000000000n)).toBe(77743.79)
    expect(wadToNumber(1n)).toBe(1e-18)
  })
  test('fmtPrice', () => {
    expect(fmtPrice(77743.79)).toBe('$77,743.79')
    expect(fmtPrice(77743_790000000000000000n)).toBe('$77,743.79')
    expect(fmtPrice(0.004)).toBe('$0.00')
  })
  test('regression: strike and order labels keep the cents at every price from $1, so nearby strikes read differently', () => {
    // A SOL market at 149.60 and one at 150.40 settle in opposite directions at 150.00.
    expect(fmtStrike(149.6)).toBe('$149.60')
    expect(fmtStrike(150.4)).toBe('$150.40')
    expect(fmtStrike(150_400000000000000000n)).toBe('$150.40')
    expect(fmtStrike(3512.25)).toBe('$3,512.25')
    expect(fmtStrike(77_743.79)).toBe('$77,743.79') // regression: BTC strikes keep their cents too
    expect(fmtStrike(77_743_790000000000000000n)).toBe('$77,743.79')
    expect(fmtStrike(1)).toBe('$1.00')
    expect(fmtStrike(0.12345)).toBe('$0.1235')
  })
})

describe('time formatting', () => {
  test('countdown', () => {
    expect(fmtCountdown(0)).toBe('0:00')
    expect(fmtCountdown(-3)).toBe('0:00')
    expect(fmtCountdown(59.9)).toBe('0:59')
    expect(fmtCountdown(61)).toBe('1:01')
    expect(fmtCountdown(3599)).toBe('59:59')
    expect(fmtCountdown(3600)).toBe('1:00:00')
    expect(fmtCountdown(3661)).toBe('1:01:01')
  })
  test('durations', () => {
    expect(fmtDuration(300)).toBe('5m')
    expect(fmtDuration(900)).toBe('15m')
    expect(fmtDuration(3600)).toBe('1h')
    expect(fmtDurationLong(300)).toBe('5 min')
    expect(fmtDurationLong(3600)).toBe('1 hour')
    expect(fmtDurationLong(7200)).toBe('2 hours')
  })
  test('shortAddr', () => {
    expect(shortAddr('0x3F04776B2b253abdC3DF386d82Bc182BE674BF7f')).toBe('0x3F04...BF7f')
  })
})
