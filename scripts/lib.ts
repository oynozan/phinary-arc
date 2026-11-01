/**
 * Shared helpers for the keeper and setup scripts (run with bun, never in the browser).
 * Reads VITE_* contract addresses and KEEPER_PRIVATE_KEY from .env (bun loads it automatically).
 */
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { getChain } from '../src/onchain-facts'

export const ASSETS = [
  { id: 0, key: 'BTC', product: 'BTC-USD', feedEnv: 'VITE_FEED_BTC' },
  { id: 1, key: 'ETH', product: 'ETH-USD', feedEnv: 'VITE_FEED_ETH' },
  { id: 2, key: 'SOL', product: 'SOL-USD', feedEnv: 'VITE_FEED_SOL' },
] as const

export const DURATIONS = [300, 900, 3600] as const

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing ${name} in .env`)
  return v
}

export function resolveRpcUrl(): string {
  const chains = (process.env.RPC_PROXY_CHAINS || '').split(',')
  if (process.env.RPC_PROXY_BASE_URL && chains.indexOf('Arc_Testnet') !== -1) {
    return `${process.env.RPC_PROXY_BASE_URL}/api/rpc/Arc_Testnet?_rpc_token=${process.env.RPC_PROXY_TOKEN}`
  }
  const urls = getChain(arcTestnet.id)?.rpcUrls
  if (!urls || urls.length === 0) throw new Error('No RPC URL known for Arc Testnet')
  return urls[0]
}

export const addresses = {
  market: need('VITE_MARKET_ADDRESS') as Address,
  oracle: need('VITE_ORACLE_ADDRESS') as Address,
  feeds: ASSETS.map((a) => need(a.feedEnv) as Address),
}

export const account = privateKeyToAccount(need('KEEPER_PRIVATE_KEY') as Hex)

const transport = http(resolveRpcUrl())
export const publicClient = createPublicClient({ chain: arcTestnet, transport })
export const walletClient = createWalletClient({ account, chain: arcTestnet, transport })

/** Latest spot from Coinbase's public ticker, scaled to 8 decimals (Chainlink USD feed convention). */
export async function coinbaseSpot8(product: string): Promise<bigint> {
  const res = await fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`)
  if (!res.ok) throw new Error(`Coinbase ${product} ticker failed: ${res.status}`)
  const body = (await res.json()) as { price: string }
  return BigInt(Math.round(Number(body.price) * 1e8))
}

export async function send(hash: Hex): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`)
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
