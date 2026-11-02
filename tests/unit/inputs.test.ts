/**
 * Input parsing as the UI does it: the stake (parseUsdcInput, BuyForm), the custom strike (checkStrike,
 * TradePage) and stop loss / take profit levels (validateOrder, BuyForm and PositionPanel).
 */
import './setup'
import { describe, expect, test } from 'bun:test'
import { parseUnits } from 'viem'
import { validateOrder } from '@/components/OrderFields'
import { costOf, parseUsdcInput, unitsForStake } from '@/lib/format'
import { checkStrike, DEFAULT_MAX_STRIKE_DEVIATION, fmtDeviation } from '@/lib/strike'
import { WAD } from './contractRef'

const spotW = (v: string) => parseUnits(v, 18)
const TEN_PCT = DEFAULT_MAX_STRIKE_DEVIATION

describe('strike input', () => {
  test('decimals, commas and 1e18 scaling', () => {
    expect(checkStrike('77,743.79', spotW('77000'), TEN_PCT).wad).toBe(77_743_790000000000000000n)
    expect(checkStrike(' 150.5 ', spotW('150'), TEN_PCT).wad).toBe(150_500000000000000000n)
    expect(checkStrike('0.000000000000000001', undefined, TEN_PCT).wad).toBe(1n)
    expect(checkStrike('', spotW('150'), TEN_PCT).error).toBe('Enter a strike price.')
    expect(checkStrike('1e5', spotW('100000'), TEN_PCT).error).toBeDefined()
    expect(checkStrike('-150', spotW('150'), TEN_PCT).error).toBeDefined()
    expect(checkStrike('0', spotW('150'), TEN_PCT).error).toBeDefined()
    expect(checkStrike('$150', spotW('150'), TEN_PCT).error).toBeDefined()
    expect(checkStrike('200', spotW('150'), TEN_PCT).error).toBe('Strike must be within 10% of $150.00.')
  })

  test('regression: the strike band matches the contract at the boundary (integer check on the oracle spot)', () => {
    // Contract: revert if |strike - spot| > spot * maxStrikeDeviation / 1e18.
    const cases = [['100', '110'], ['100', '90'], ['150.37', '165.407'], ['150.37', '135.333'], ['77743.79', '85518.169'], ['77743.79', '69969.411'], ['100', '110.000000000000000001'], ['100', '89.999999999999999999']] as const
    for (const [spot, k] of cases) {
      const s = spotW(spot)
      const kW = spotW(k)
      const diff = kW > s ? kW - s : s - kW
      const contractOk = !(diff > (s * TEN_PCT) / WAD)
      expect({ spot, k, ok: checkStrike(k, s, TEN_PCT).error === undefined }).toEqual({ spot, k, ok: contractOk })
    }
    expect(checkStrike('110', spotW('100'), TEN_PCT).error).toBeUndefined()
  })

  test('the band follows the contract\'s maxStrikeDeviation instead of a hardcoded 10%', () => {
    const fivePct = 5n * 10n ** 16n
    expect(checkStrike('106', spotW('100'), fivePct).error).toBe('Strike must be within 5% of $100.00.')
    expect(checkStrike('105', spotW('100'), fivePct).error).toBeUndefined()
    expect(fmtDeviation(125n * 10n ** 15n)).toBe('12.5%')
  })
})

describe('stake input (BuyForm)', () => {
  test('valid amounts', () => {
    expect(parseUsdcInput('5')).toBe(5_000_000n)
    expect(parseUsdcInput('')).toBe(0n)
    expect(parseUsdcInput('abc')).toBe(0n)
    expect(parseUsdcInput('0.0000001')).toBe(0n) // too many decimals -> treated as empty
  })

  test('regression: a negative amount reads as no stake, so the bet button stays disabled', () => {
    const balance = 100_000_000n
    const price = 52n * 10n ** 16n
    const stake = parseUsdcInput('-5')
    expect(stake).toBe(0n)
    const units = unitsForStake(stake, price)
    // BuyForm: invalid = closed || stale || units <= 0n || insufficient || ...
    expect(units <= 0n || costOf(units, price) > balance).toBe(true)
  })
})

describe('validateOrder (stop loss / take profit) mirrors setOrder', () => {
  const spot = 100_000n * WAD
  test('UP: stop < spot < take profit', () => {
    expect(validateOrder(true, spot, '99,000', '101000.5').error).toBeUndefined()
    expect(validateOrder(true, spot, '99000', '101000.5').takeProfit).toBe(101_000_500000000000000000n)
    expect(validateOrder(true, spot, '100000', '').error).toBeDefined()
    expect(validateOrder(true, spot, '', '100000').error).toBeDefined()
  })
  test('DOWN: take profit < spot < stop', () => {
    expect(validateOrder(false, spot, '101000', '99000').error).toBeUndefined()
    expect(validateOrder(false, spot, '99000', '').error).toBeDefined()
  })
  test('empty, invalid, zero, negative', () => {
    expect(validateOrder(true, spot, '', '')).toEqual({ stop: 0n, takeProfit: 0n })
    expect(validateOrder(true, spot, 'abc', '').error).toBe('Enter valid prices.')
    expect(validateOrder(true, spot, '0', '').error).toBe('Enter valid prices.')
    expect(validateOrder(true, spot, '-5', '').error).toBe('Enter valid prices.')
    expect(validateOrder(true, undefined, '1', '').error).toBe('Waiting for the oracle price.')
  })
})
