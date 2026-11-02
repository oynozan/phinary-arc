import './setup'
import { describe, expect, test } from 'bun:test'
import { Amount, AmountError, formatUnitsExact, formatUnitsFixed, gasTokenToUsdc, isGasTokenUsdc, parseAmount, parseUnitsExact, parseUsdc, usdcDecimalsFor, usdcToGasToken } from '@/onchain-money'
import { rng } from './contractRef'

const ARC_TESTNET = 5042002

describe('parseUnitsExact', () => {
  test('accepts plain decimals', () => {
    expect(parseUsdc('5')).toBe(5_000_000n)
    expect(parseUsdc('0.000001')).toBe(1n)
    expect(parseUsdc('.5')).toBe(500_000n)
    expect(parseUsdc('5.')).toBe(5_000_000n)
    expect(parseUsdc(' 12.34 ')).toBe(12_340_000n)
    expect(parseUsdc('-1.5')).toBe(-1_500_000n)
    expect(parseUnitsExact('1', 18)).toBe(10n ** 18n)
  })
  test('rejects separators, exponents, signs, too many decimals', () => {
    for (const bad of ['1,000', '1e3', '+1', '$5', '', '.', '1.2.3', 'NaN', 'Infinity', '0x10']) {
      expect(() => parseUsdc(bad)).toThrow(AmountError)
    }
    expect(() => parseUsdc('0.0000001')).toThrow(/fraction digits/)
  })
  test('fuzz round trip: parse(formatExact(x)) == x and formatFixed truncates', () => {
    const r = rng(21)
    for (let i = 0; i < 5000; i++) {
      const raw = BigInt(Math.floor((r() - 0.3) * 2 ** 52)) * BigInt(1 + Math.floor(r() * 1000))
      expect(parseUsdc(formatUnitsExact(raw, 6))).toBe(raw)
      const fixed = formatUnitsFixed(raw, 6, 2)
      const back = parseUsdc(fixed)
      const abs = raw < 0n ? -raw : raw
      const absBack = back < 0n ? -back : back
      expect(abs - absBack).toBeGreaterThanOrEqual(0n)
      expect(abs - absBack).toBeLessThan(10_000n)
    }
  })
  test('formatUnitsFixed of a tiny negative keeps the sign ("-0.00")', () => {
    expect(formatUnitsFixed(-1n, 6, 2)).toBe('-0.00')
  })
})

describe('Amount', () => {
  test('refuses to mix decimals, rescales exactly or truncates', () => {
    const a = Amount.parse('1.5', 6)
    const b = Amount.parse('1.5', 18)
    expect(() => a.add(b)).toThrow(/decimal/)
    expect(a.toDecimals(18).eq(b)).toBe(true)
    expect(() => Amount.fromRaw(1n, 18).toDecimals(6)).toThrow(/PRECISION|drop/)
    expect(Amount.fromRaw(1_999_999_999_999n, 18).toDecimals(6, 'trunc').raw).toBe(1n)
    expect(Amount.sum([], 6).isZero()).toBe(true)
    expect(() => Amount.sum([])).toThrow(AmountError)
    expect(() => a.div(0n)).toThrow(AmountError)
    const { quotient, remainder } = Amount.fromRaw(10n, 6).divmod(3n)
    expect([quotient.raw, remainder.raw]).toEqual([3n, 1n])
  })
})

describe('Arc chain facts', () => {
  test('Arc Testnet: USDC 6 decimals, gas token is USDC at 18', () => {
    expect(usdcDecimalsFor(ARC_TESTNET)).toBe(6)
    expect(isGasTokenUsdc(ARC_TESTNET)).toBe(true)
    const one = parseAmount(ARC_TESTNET, '1')
    expect(usdcToGasToken(ARC_TESTNET, one).raw).toBe(10n ** 18n)
    expect(gasTokenToUsdc(ARC_TESTNET, Amount.fromRaw(10n ** 18n + 123n, 18)).raw).toBe(1_000_000n)
  })
})
