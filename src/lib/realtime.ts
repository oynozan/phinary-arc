import { createPublicClient, webSocket } from 'viem'
import { CHAIN, RPC_WS } from './network'

/**
 * viem retries a dropped socket once; if that retry fails, the next one only happens on the next keep-alive
 * ping, and after `attempts` failures it gives up for good. So ping often and never run out of attempts.
 */
export const WS_TRANSPORT_OPTIONS = { reconnect: { attempts: Number.MAX_SAFE_INTEGER, delay: 1500 }, keepAlive: { interval: 5_000 }, retryCount: 3 }

/**
 * One WebSocket connection to Arc for the whole app. All live data (prices, markets, positions,
 * balances) is pushed over it with eth_subscribe, so nothing in the UI polls.
 */
export const wsClient = createPublicClient({
  chain: CHAIN,
  transport: webSocket(RPC_WS, WS_TRANSPORT_OPTIONS),
})

const reconnectListeners = new Set<() => void>()
let reconnectWatch: ReturnType<typeof setInterval> | undefined
let lastSocket: unknown

/**
 * Events pushed while the socket was down are never replayed. viem swaps in a new socket object when it
 * reconnects, so a different open socket means a reconnect and the listeners resync.
 */
export async function checkSocket(): Promise<void> {
  try {
    const socket = (await wsClient.transport.getRpcClient()).socket
    if (socket.readyState !== 1) return
    if (lastSocket !== undefined && socket !== lastSocket) reconnectListeners.forEach((l) => l())
    lastSocket = socket
  } catch {
    /* still connecting */
  }
}

/** Calls `onReconnect` after every reconnect of the shared socket. Returns the unsubscribe. */
export function watchReconnects(onReconnect: () => void): () => void {
  reconnectListeners.add(onReconnect)
  reconnectWatch ??= setInterval(() => void checkSocket(), 3000)
  return () => {
    reconnectListeners.delete(onReconnect)
    if (reconnectListeners.size === 0 && reconnectWatch) {
      clearInterval(reconnectWatch)
      reconnectWatch = undefined
    }
  }
}

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
