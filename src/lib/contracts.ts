import { arcTestnet } from 'viem/chains'
import type { Address } from 'viem'
import { marketAbi, oracleAbi } from './abis'
import { getUsdc } from '@/onchain-facts'

export const CHAIN_ID = arcTestnet.id

const env = import.meta.env
export const MARKET_ADDRESS = env.VITE_MARKET_ADDRESS as Address
export const ORACLE_ADDRESS = env.VITE_ORACLE_ADDRESS as Address
export const FEED_ADDRESSES = [env.VITE_FEED_BTC, env.VITE_FEED_ETH, env.VITE_FEED_SOL] as Address[]
export const DEPLOY_BLOCK = BigInt((env.VITE_DEPLOY_BLOCK as string | undefined) ?? '0')

export const MARKET = { address: MARKET_ADDRESS, abi: marketAbi, chainId: CHAIN_ID } as const
export const ORACLE = { address: ORACLE_ADDRESS, abi: oracleAbi, chainId: CHAIN_ID } as const

const usdc = getUsdc(CHAIN_ID)
if (!usdc) throw new Error('USDC is not registered for Arc Testnet')
export const USDC_ADDRESS = usdc.address as Address
export const USDC_DECIMALS = usdc.decimals

export interface AssetMeta {
  id: number
  key: 'BTC' | 'ETH' | 'SOL'
  name: string
  product: string
}

export const ASSETS: readonly AssetMeta[] = [
  { id: 0, key: 'BTC', name: 'Bitcoin', product: 'BTC-USD' },
  { id: 1, key: 'ETH', name: 'Ethereum', product: 'ETH-USD' },
  { id: 2, key: 'SOL', name: 'Solana', product: 'SOL-USD' },
]

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
