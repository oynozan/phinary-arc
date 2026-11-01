import { createPublicClient, webSocket } from 'viem'
import { arcTestnet } from 'viem/chains'
import { requireChain } from '@/onchain-facts'

const http = requireChain(arcTestnet.id).rpcUrls[0]
export const WS_URL = http.replace(/^http/, 'ws')

/**
 * One WebSocket connection to Arc for the whole app. All live data (prices, markets, positions,
 * balances) is pushed over it with eth_subscribe, so nothing in the UI polls.
 */
export const wsClient = createPublicClient({
  chain: arcTestnet,
  transport: webSocket(WS_URL, { reconnect: { attempts: 20, delay: 1500 }, keepAlive: { interval: 20_000 }, retryCount: 3 }),
})

/** Arc's RPC rejects more than ~20 requests in flight on one connection, so reads are queued 8 at a time. */
const MAX_IN_FLIGHT = 8
let inFlight = 0
const waiting: Array<() => void> = []

async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve))
  inFlight++
  try {
    return await job()
  } finally {
    inFlight--
    waiting.shift()?.()
  }
}

const QUEUED = new Set<string | symbol>(['readContract', 'multicall', 'getLogs', 'getContractEvents', 'getBlockNumber', 'getBlock', 'getTransactionReceipt'])

/** Same client as wsClient, but one-off reads go through the queue. Subscriptions (watch*) stay on wsClient. */
export const rpc = new Proxy(wsClient, {
  get(target, prop, receiver) {
    const value: unknown = Reflect.get(target, prop, receiver)
    if (typeof value === 'function' && QUEUED.has(prop)) {
      return (...args: unknown[]) => limited(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args))
    }
    return value
  },
})
