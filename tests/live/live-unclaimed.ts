// Live probe: positions with claimable money in markets that fetchMarkets() (last 60 ids) no longer returns.
// The Positions table now also reads each wallet's own markets from its Bought logs, so these keep their
// Claim button. Run: bun run tests/live/live-unclaimed.ts
import { createPublicClient, http } from 'viem'
import { arcTestnet } from 'viem/chains'
import { marketAbi } from '../../src/lib/abis'

const MARKET = '0xad96602776250f18a4d46ab7b2f0c56a5fda2df5' as const
const c = createPublicClient({ chain: arcTestnet, transport: http('https://rpc.testnet.arc.io') })
const head = await c.getBlockNumber()
const count = await c.readContract({ address: MARKET, abi: marketAbi, functionName: 'marketCount' })
const windowFrom = count - 59n
const users = new Map<string, Set<bigint>>()
for (let to = head; to > head - 200_000n; to -= 10_000n) {
  const logs = await c.getContractEvents({ address: MARKET, abi: marketAbi, eventName: 'Bought', fromBlock: to - 9_999n, toBlock: to })
  for (const l of logs) {
    const id = l.args.marketId!
    if (id >= windowFrom) continue
    const k = l.args.user!
    if (!users.has(k)) users.set(k, new Set())
    users.get(k)!.add(id)
  }
}
let found = 0
for (const [u, ids] of users) {
  for (const id of ids) {
    const m = await c.readContract({ address: MARKET, abi: marketAbi, functionName: 'getMarket', args: [id] })
    const [up, down, upCost, downCost] = await c.readContract({ address: MARKET, abi: marketAbi, functionName: 'getPosition', args: [id, u as `0x${string}`] })
    const claimable = m.status === 1 ? (m.upWon ? up : down) : m.status === 2 ? upCost + downCost : 0n
    if (claimable > 0n || (m.status === 0 && (up > 0n || down > 0n))) {
      found++
      console.log(`user ${u} market ${id} (outside window, oldest listed = ${windowFrom}) status=${m.status} claimable=${claimable} up=${up} down=${down}`)
    }
  }
}
console.log('marketCount', count, 'window starts at', windowFrom, 'positions with money outside window:', found)
