/** Compares the browser pricing port (src/lib/pricing.ts) with the contract's quote() on open markets. */
import { marketAbi, oracleAbi } from '../src/lib/abis'
import { localQuote } from '../src/lib/pricing'
import { addresses, publicClient } from './lib'

const count = await publicClient.readContract({ address: addresses.market, abi: marketAbi, functionName: 'marketCount' })
const from = count > 20n ? count - 19n : 1n
const list = await publicClient.readContract({ address: addresses.market, abi: marketAbi, functionName: 'getMarketsRange', args: [from, count - from + 1n] })
const edge = Number(await publicClient.readContract({ address: addresses.market, abi: marketAbi, functionName: 'priceEdge' })) / 1e18
const nowS = Math.floor(Date.now() / 1000)
let checked = 0
for (const [i, m] of list.entries()) {
  if (m.status !== 0 || m.expiry - nowS < 30) continue
  const id = from + BigInt(i)
  const on = await publicClient.readContract({ address: addresses.market, abi: marketAbi, functionName: 'quote', args: [id] })
  const sigma = Number(await publicClient.readContract({ address: addresses.oracle, abi: oracleAbi, functionName: 'getVol', args: [m.assetId] })) / 1e18
  const local = localQuote({ spot: Number(on[5]) / 1e18, strike: Number(m.strike) / 1e18, sigma, timeLeft: Number(on[7]) / 1e18 > 1e9 ? Number(on[7]) : Number(on[7]), edge })
  const cmp = (a: bigint, b: bigint) => Math.abs(Number(a) - Number(b)) / 1e18
  console.log(`market ${id} asset ${m.assetId}`, 'fairUp', (Number(on[0]) / 1e18).toFixed(4), 'vs', (Number(local.fairUp) / 1e18).toFixed(4), 'diff', cmp(on[0], local.fairUp).toExponential(1), '| buyUp diff', cmp(on[1], local.buyUp).toExponential(1), '| sellDown diff', cmp(on[4], local.sellDown).toExponential(1))
  checked++
}
console.log('checked', checked)
