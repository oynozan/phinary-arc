import './setup'
import { describe, expect, test } from 'bun:test'
import { arc, arcTestnet } from 'viem/chains'
import { assetsWithFeeds, ASSETS, CHAIN_ID, KEEPER_ADDRESSES, parseKeepers, USDC_ADDRESS } from '@/lib/contracts'
import { CHAIN, isTestnet, parseNetwork, RPC_HTTP, RPC_WS } from '@/lib/network'
import { getUsdc } from '@/onchain-facts'
import { maxWithdrawShares, MIN_SUPPLY_WHILE_OPEN } from '@/lib/vault'

const A = '0x83eec3cbda541e441ff5f919fa47faefb20678ae'
const B = '0xc7e7bcd1e9a28cecb58dad6a4459b9f81db4c970'

describe('network (VITE_NETWORK)', () => {
  test('testnet by default, mainnet on request, anything else is a configuration error', () => {
    expect(parseNetwork(undefined)).toBe('testnet')
    expect(parseNetwork('')).toBe('testnet')
    expect(parseNetwork('testnet')).toBe('testnet')
    expect(parseNetwork(' mainnet ')).toBe('mainnet')
    expect(() => parseNetwork('Mainnet')).toThrow()
    expect(() => parseNetwork('arc')).toThrow()
  })

  test('the test env runs on Arc Testnet with its RPCs and USDC', () => {
    expect(isTestnet).toBe(true)
    expect(CHAIN.id).toBe(arcTestnet.id)
    expect(CHAIN_ID).toBe(5042002)
    expect(RPC_HTTP).toBe('https://rpc.testnet.arc.io')
    expect(RPC_WS).toBe('wss://rpc.testnet.arc.io')
    expect(USDC_ADDRESS).toBe('0x3600000000000000000000000000000000000000')
  })

  test('mainnet chain id resolves in onchain-facts (USDC is the same ERC-20 address)', () => {
    expect(arc.id).toBe(5042)
    expect(getUsdc(arc.id)).toEqual({ symbol: 'USDC', address: '0x3600000000000000000000000000000000000000', decimals: 6 })
  })
})

describe('assets (VITE_FEED_*)', () => {
  test('only assets with a feed are offered, each keeping its own id and feed (not the array index)', () => {
    const list = assetsWithFeeds({ VITE_FEED_BTC: A, VITE_FEED_NVDA: B })
    expect(list.map((a) => [a.id, a.key, a.kind, a.feed])).toEqual([
      [0, 'BTC', 'crypto', A],
      [3, 'NVDA', 'stock', B],
    ])
  })

  test('all five, with their chart sources', () => {
    const list = assetsWithFeeds({ VITE_FEED_BTC: A, VITE_FEED_ETH: A, VITE_FEED_SOL: A, VITE_FEED_NVDA: B, VITE_FEED_AAPL: B })
    expect(list.map((a) => `${a.id}:${a.key}:${a.name}:${a.chart}`)).toEqual(['0:BTC:Bitcoin:BTC-USD', '1:ETH:Ethereum:ETH-USD', '2:SOL:Solana:SOL-USD', '3:NVDA:Nvidia:NVDAx/USD', '4:AAPL:Apple:AAPLx/USD'])
  })

  test('an empty value means unset; a malformed address fails loudly', () => {
    expect(assetsWithFeeds({ VITE_FEED_BTC: '  ', VITE_FEED_ETH: A }).map((a) => a.key)).toEqual(['ETH'])
    expect(() => assetsWithFeeds({ VITE_FEED_AAPL: '0x1234' })).toThrow('VITE_FEED_AAPL')
  })

  test('the test env (the live testnet deployment) lists BTC, ETH and SOL only', () => {
    expect(ASSETS.map((a) => a.id)).toEqual([0, 1, 2])
  })
})

describe('keepers (VITE_KEEPER_ADDRESS)', () => {
  test('one address or a comma-separated list', () => {
    expect(parseKeepers(undefined)).toEqual([])
    expect(parseKeepers('')).toEqual([])
    expect(parseKeepers(A)).toEqual([A])
    expect(parseKeepers(` ${A} , ${B},`)).toEqual([A, B])
    expect(() => parseKeepers(`${A},nope`)).toThrow('VITE_KEEPER_ADDRESS')
    expect(KEEPER_ADDRESSES).toEqual(['0x3F04776B2b253abdC3DF386d82Bc182BE674BF7f'])
  })
})

describe('maxWithdrawShares (vault keeps one share while markets are open)', () => {
  const ONE = MIN_SUPPLY_WHILE_OPEN
  test('no open markets: everything the wallet holds', () => {
    expect(maxWithdrawShares(10n * ONE, 10n * ONE, false)).toBe(10n * ONE)
  })
  test('open markets, sole LP: all but one share', () => {
    expect(maxWithdrawShares(10n * ONE, 10n * ONE, true)).toBe(9n * ONE)
  })
  test('open markets, other LPs hold less than a share: capped so total supply keeps 1e9 units', () => {
    const mine = 10n * ONE
    const total = mine + ONE / 2n
    const max = maxWithdrawShares(mine, total, true)
    expect(total - max).toBe(ONE)
    expect(max).toBeLessThan(mine)
  })
  test('open markets, other LPs hold at least a share: the wallet can leave entirely', () => {
    expect(maxWithdrawShares(10n * ONE, 11n * ONE, true)).toBe(10n * ONE)
  })
  test('open markets, supply at or under one share: nothing', () => {
    expect(maxWithdrawShares(ONE, ONE, true)).toBe(0n)
    expect(maxWithdrawShares(ONE / 2n, ONE / 2n, true)).toBe(0n)
  })
})
