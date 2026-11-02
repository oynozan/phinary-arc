import './setup'
import { test, expect } from 'bun:test'
import { worstBuyPrice } from '@/lib/bet'
import { MARKET_ADDRESS, USDC_DECIMALS } from '@/lib/contracts'

test('app modules import under bun', () => {
  expect(MARKET_ADDRESS).toBe(process.env.VITE_MARKET_ADDRESS as `0x${string}`)
  expect(USDC_DECIMALS).toBe(6)
  expect(typeof worstBuyPrice).toBe('function')
})
