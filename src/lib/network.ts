import type { Chain } from 'viem'
import { arc, arcTestnet } from 'viem/chains'
import { requireChain } from '@/onchain-facts'

/** VITE_NETWORK picks the Arc network the whole app talks to: 'testnet' (default) or 'mainnet'. */
export function parseNetwork(raw: string | undefined): 'testnet' | 'mainnet' {
  const v = raw?.trim() || 'testnet'
  if (v !== 'testnet' && v !== 'mainnet') throw new Error(`VITE_NETWORK must be 'testnet' or 'mainnet', got '${v}'`)
  return v
}

const env = import.meta.env
export const NETWORK = parseNetwork(env.VITE_NETWORK as string | undefined)
export const isTestnet = NETWORK === 'testnet'
export const CHAIN: Chain = isTestnet ? arcTestnet : arc

/** RPC endpoints. viem's `arc` chain lists no WebSocket URL, so both defaults are spelled out here. */
export const RPC_HTTP = (env.VITE_RPC_HTTP as string | undefined) || requireChain(CHAIN.id).rpcUrls[0]
export const RPC_WS = (env.VITE_RPC_WS as string | undefined) || (isTestnet ? 'wss://rpc.testnet.arc.io' : 'wss://rpc.mainnet.arc.io')
