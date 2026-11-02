// What happens to the app's single WebSocket client (src/lib/realtime.ts) when the connection drops.
// Uses a local anvil as the chain and a local WebSocket proxy that can be taken down (no internet needed, but
// it needs the anvil binary, so it is a script, not part of `bun test`). The client uses the app's own
// WS_TRANSPORT_OPTIONS and subscribes the way useRealtimeSync does (watchEvent, poll: false).
// Expected: reads work again within a few seconds of the proxy coming back. Logs emitted during the outage
// are still not replayed by the subscription; useRealtimeSync refetches everything on reconnect instead.
//
// Usage: bun run tests/frontend/ws-reconnect.ts <outageSeconds> [secondsToWaitAfter]
import { createPublicClient, createWalletClient, http, webSocket, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { WS_TRANSPORT_OPTIONS } from '../../src/lib/realtime'

const OUTAGE_S = Number(process.argv[2] ?? '5')
const ANVIL_PORT = 18547
const PROXY_PORT = 18548
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)

const anvil = Bun.spawn(['anvil', '--port', String(ANVIL_PORT), '--silent'], { stdout: 'ignore', stderr: 'ignore' })
for (let i = 0; i < 50; i++) {
  try {
    await fetch(`http://127.0.0.1:${ANVIL_PORT}`, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', headers: { 'content-type': 'application/json' } })
    break
  } catch {
    await sleep(200)
  }
}

// --- proxy that can be switched off ---
let up = true
const clients = new Set<import('bun').ServerWebSocket<{ upstream?: WebSocket; queue: string[] }>>()
const proxy = Bun.serve<{ upstream?: WebSocket; queue: string[] }>({
  port: PROXY_PORT,
  fetch(req, server) {
    if (!up) return new Response('down', { status: 503 })
    if (server.upgrade(req, { data: { queue: [] } })) return
    return new Response('ws only', { status: 400 })
  },
  websocket: {
    open(ws) {
      clients.add(ws)
      const upstream = new WebSocket(`ws://127.0.0.1:${ANVIL_PORT}`)
      ws.data.upstream = upstream
      upstream.onopen = () => {
        for (const m of ws.data.queue) upstream.send(m)
        ws.data.queue = []
      }
      upstream.onmessage = (e) => ws.send(String(e.data))
      upstream.onclose = () => ws.close()
    },
    message(ws, msg) {
      const u = ws.data.upstream!
      if (u.readyState === WebSocket.OPEN) u.send(String(msg))
      else ws.data.queue.push(String(msg))
    },
    close(ws) {
      clients.delete(ws)
      ws.data.upstream?.close()
    },
  },
})
const takeDown = () => {
  up = false
  for (const c of clients) c.close()
}

// --- chain helpers: a contract that emits LOG0 on every call ---
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const chain = { ...foundry, id: 31337 }
const wallet = createWalletClient({ account, chain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
const direct = createPublicClient({ chain, pollingInterval: 100, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
const deployHash = await wallet.sendTransaction({ data: '0x600b600c600039600b6000f3602a60005260206000a000' })
const emitter = (await direct.waitForTransactionReceipt({ hash: deployHash })).contractAddress as Address
let n = 0
const emit = async () => {
  const h = await wallet.sendTransaction({ to: emitter, data: '0x' })
  await direct.waitForTransactionReceipt({ hash: h })
  n++
  log(`emitted event #${n}`)
  return n
}

// --- the app's client, with the options from src/lib/realtime.ts ---
const wsClient = createPublicClient({
  chain,
  transport: webSocket(`ws://127.0.0.1:${PROXY_PORT}`, WS_TRANSPORT_OPTIONS),
})
const received: number[] = []
let seen = 0
wsClient.watchEvent({
  address: emitter,
  poll: false,
  onLogs: (logs) => {
    for (const _ of logs) received.push(++seen)
    log(`subscription delivered ${logs.length} log(s)`)
  },
  onError: (e) => log('subscription error:', e.name),
})
await sleep(1000)

await emit() // #1, connected
await sleep(800)
log(`proxy DOWN for ${OUTAGE_S}s`)
takeDown()
await sleep(300)
await emit() // #2, during the outage
await sleep(OUTAGE_S * 1000)
up = true
log('proxy UP')
await sleep(Number(process.argv[3] ?? '6') * 1000)
await emit() // #3, after the outage
await sleep(2500)

let readOk = false
try {
  await wsClient.getBlockNumber()
  readOk = true
} catch (e) {
  log('read through the app client failed:', (e as Error).name)
}
console.log(JSON.stringify({ outageSeconds: OUTAGE_S, emitted: n, deliveredToSubscription: received.length, readAfterOutageWorks: readOk }))
proxy.stop(true)
anvil.kill()
process.exit(0)
