import { isAddress, type Address } from 'viem'
import { marketAbi, oracleAbi } from './abis'
import { CHAIN } from './network'
import { getUsdc } from '@/onchain-facts'

export const CHAIN_ID = CHAIN.id

const env = import.meta.env as Record<string, string | undefined>

/** A configured address, checked at load so a typo fails loudly instead of subscribing to nothing. */
function envAddress(name: string, value: string): Address {
  if (!isAddress(value)) throw new Error(`${name} is not an address: '${value}'`)
  return value
}

export const MARKET_ADDRESS = env.VITE_MARKET_ADDRESS as Address
export const ORACLE_ADDRESS = env.VITE_ORACLE_ADDRESS as Address
export const DEPLOY_BLOCK = BigInt(env.VITE_DEPLOY_BLOCK ?? '0')

/** VITE_KEEPER_ADDRESS: one address or a comma-separated list. Markets they open are the rolling ones shown per duration. */
export function parseKeepers(raw: string | undefined): Address[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => envAddress('VITE_KEEPER_ADDRESS', s))
}
export const KEEPER_ADDRESSES = parseKeepers(env.VITE_KEEPER_ADDRESS)

export const MARKET = { address: MARKET_ADDRESS, abi: marketAbi, chainId: CHAIN_ID } as const
export const ORACLE = { address: ORACLE_ADDRESS, abi: oracleAbi, chainId: CHAIN_ID } as const

const usdc = getUsdc(CHAIN_ID)
if (!usdc) throw new Error(`USDC is not registered for ${CHAIN.name}`)
export const USDC_ADDRESS = usdc.address as Address
export const USDC_DECIMALS = usdc.decimals

export type AssetKey = 'BTC' | 'ETH' | 'SOL' | 'NVDA' | 'AAPL'

export interface AssetMeta {
  id: number
  key: AssetKey
  name: string
  kind: 'crypto' | 'stock'
  /** live chart source: a Coinbase product for crypto, a Kraken xStocks WebSocket symbol for stocks */
  chart: string
  /** the price feed the oracle adapter reads for this asset id */
  feed: Address
}

const ALL_ASSETS: readonly Omit<AssetMeta, 'feed'>[] = [
  { id: 0, key: 'BTC', name: 'Bitcoin', kind: 'crypto', chart: 'BTC-USD' },
  { id: 1, key: 'ETH', name: 'Ethereum', kind: 'crypto', chart: 'ETH-USD' },
  { id: 2, key: 'SOL', name: 'Solana', kind: 'crypto', chart: 'SOL-USD' },
  { id: 3, key: 'NVDA', name: 'Nvidia', kind: 'stock', chart: 'NVDAx/USD' },
  { id: 4, key: 'AAPL', name: 'Apple', kind: 'stock', chart: 'AAPLx/USD' },
]

/** The assets whose VITE_FEED_<KEY> is set. An asset without a feed has no oracle price, so it is not offered. */
export function assetsWithFeeds(vars: Record<string, string | undefined>): AssetMeta[] {
  return ALL_ASSETS.flatMap((a) => {
    const v = vars[`VITE_FEED_${a.key}`]?.trim()
    return v ? [{ ...a, feed: envAddress(`VITE_FEED_${a.key}`, v) }] : []
  })
}

export const ASSETS: readonly AssetMeta[] = assetsWithFeeds(env)
if (ASSETS.length === 0) throw new Error('No VITE_FEED_* address is set, so there is no asset to trade')

/** Metadata for an asset id, or undefined for an id this build does not list (its markets must not crash the UI). */
export const assetById = (id: number): AssetMeta | undefined => ASSETS.find((a) => a.id === id)
export const assetKey = (id: number): string => assetById(id)?.key ?? ALL_ASSETS.find((a) => a.id === id)?.key ?? `Asset ${id}`

export const WAD = 10n ** 18n
export const TRADING_CLOSE_BUFFER_S = 15

export interface Market {
  id: bigint
  assetId: number
  status: number // 0 open, 1 settled, 2 voided
  upWon: boolean
  createdAt: number
  expiry: number
  strike: bigint
  settlePrice: bigint
  upUnits: bigint
  downUnits: bigint
  totalCost: bigint
  /** opened by the keeper (the rolling market), when known */
  byKeeper?: boolean
}

export interface Quote {
  fairUp: bigint
  buyUp: bigint
  sellUp: bigint
  buyDown: bigint
  sellDown: bigint
  spot: bigint
  sigma: bigint
  timeLeft: bigint
}
