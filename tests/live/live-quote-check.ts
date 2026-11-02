/**
 * Read-only live check against Arc Testnet: compares the browser pricing port with the
 * deployed contract's quote() and reports the live vol/edge used by the slippage tests.
 * Run: bun run tests/live/live-quote-check.ts
 */
import { createPublicClient, http } from 'viem'
import { arcTestnet } from 'viem/chains'
import { marketAbi, oracleAbi } from '../../src/lib/abis'
import { localQuote } from '../../src/lib/pricing'

const market = '0xad96602776250f18a4d46ab7b2f0c56a5fda2df5' as const
const oracle = '0x465ec9f24ad95cdb73c72b2de1ccb0ac827723e3' as const
const client = createPublicClient({ chain: arcTestnet, transport: http('https://rpc.testnet.arc.io') })

const edgeRaw = await client.readContract({ address: market, abi: marketAbi, functionName: 'priceEdge' })
const edge = Number(edgeRaw) / 1e18
console.log('edge', edge)
for (const id of [0, 1, 2]) {
  const vol = await client.readContract({ address: oracle, abi: oracleAbi, functionName: 'getVol', args: [id] })
  console.log('asset', id, 'sigma', Number(vol) / 1e18)
}
const count = await client.readContract({ address: market, abi: marketAbi, functionName: 'marketCount' })
console.log('marketCount', count)
const from = count > 30n ? count - 29n : 1n
const list = await client.readContract({ address: market, abi: marketAbi, functionName: 'getMarketsRange', args: [from, count - from + 1n] })
const block = await client.getBlock()
const nowS = Number(block.timestamp)
let maxDiff = 0
for (const [i, m] of list.entries()) {
  if (m.status !== 0 || Number(m.expiry) - nowS < 20) continue
  const id = from + BigInt(i)
  const on = await client.readContract({ address: market, abi: marketAbi, functionName: 'quote', args: [id] })
  const sigma = Number(await client.readContract({ address: oracle, abi: oracleAbi, functionName: 'getVol', args: [m.assetId] })) / 1e18
  const local = localQuote({ spot: Number(on[5]) / 1e18, strike: Number(m.strike) / 1e18, sigma, timeLeft: Number(on[7]), edge })
  const d = (a: bigint, b: bigint) => Math.abs(Number(a - b)) / 1e18
  const diffs = [d(on[0], local.fairUp), d(on[1], local.buyUp), d(on[2], local.sellUp), d(on[3], local.buyDown), d(on[4], local.sellDown)]
  maxDiff = Math.max(maxDiff, ...diffs)
  console.log(`market ${id} asset ${m.assetId} dur ${Number(m.expiry) - Number(m.createdAt)} timeLeft ${on[7]} fairUp chain ${(Number(on[0]) / 1e18).toFixed(6)} local ${(Number(local.fairUp) / 1e18).toFixed(6)} maxdiff ${Math.max(...diffs).toExponential(2)}`)
}
console.log('max abs diff across open markets', maxDiff.toExponential(3))
