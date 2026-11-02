// Live testnet probe: block time, market window covered by fetchMarkets' "last 60", getLogs range limits.
// Run: bun run tests/live/live-probe.ts
import { createPublicClient, http } from 'viem'
import { arcTestnet } from 'viem/chains'
import { marketAbi } from '../../src/lib/abis'

const MARKET = '0xad96602776250f18a4d46ab7b2f0c56a5fda2df5' as const
const c = createPublicClient({ chain: arcTestnet, transport: http('https://rpc.testnet.arc.io') })

const head = await c.getBlockNumber()
const bh = await c.getBlock({ blockNumber: head })
const bo = await c.getBlock({ blockNumber: head - 10_000n })
console.log('head', head, 'avg block time s', Number(bh.timestamp - bo.timestamp) / 10_000)

const count = await c.readContract({ address: MARKET, abi: marketAbi, functionName: 'marketCount' })
console.log('marketCount', count)
const take = count > 60n ? 60n : count
const from = count - take + 1n
const list = await c.readContract({ address: MARKET, abi: marketAbi, functionName: 'getMarketsRange', args: [from, take] })
const now = Number(bh.timestamp)
const oldest = list[0]
console.log('oldest market in 60-window: id', from, 'createdAt age (min)', ((now - Number(oldest.createdAt)) / 60).toFixed(1), 'expiry age (min)', ((now - Number(oldest.expiry)) / 60).toFixed(1))
// markets per hour
const hourAgo = list.filter((m) => now - Number(m.createdAt) <= 3600).length
console.log('markets created in the last hour (within window):', hourAgo)
// the oldest settled/claimable 1h markets that dropped out: show markets just below the window
const below = await c.readContract({ address: MARKET, abi: marketAbi, functionName: 'getMarketsRange', args: [from - 20n > 0n ? from - 20n : 1n, 20n] })
for (const [i, m] of below.entries()) {
  const id = (from - 20n) + BigInt(i)
  if (Number(m.expiry) - Number(m.createdAt) === 3600) console.log('1h market outside window id', id, 'status', m.status, 'expired min ago', ((now - Number(m.expiry)) / 60).toFixed(1))
}

for (const span of [10_000n, 10_001n, 50_000n]) {
  try {
    const logs = await c.getLogs({ address: MARKET, fromBlock: head - span + 1n, toBlock: head })
    console.log('getLogs span', span, 'ok', logs.length)
  } catch (e) {
    console.log('getLogs span', span, 'FAILED', (e as Error).message.split('\n')[0])
  }
}
