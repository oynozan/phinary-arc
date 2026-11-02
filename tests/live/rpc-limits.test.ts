/* oxlint-disable typescript/no-explicit-any -- live probes read loosely typed RPC results */
/**
 * Probes the public Arc Testnet RPC with the exact log-range requests the app makes
 * (src/hooks/history.ts: 10_000-block getLogs; src/hooks/useMarketBets.ts: 5_000-block
 * getContractEvents; scripts/keeper.ts: 2_000-block chunks). bun test tests/live/rpc-limits.test.ts
 */
import { describe, expect, test } from 'bun:test'

const RPC = process.env.ARC_RPC ?? 'https://rpc.testnet.arc.io'
const MARKET = '0xad96602776250f18a4d46ab7b2f0c56a5fda2df5'

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return (await res.json()) as { result?: any; error?: { code: number; message: string } }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function getLogsRange(span: number) {
  const head = BigInt((await rpc('eth_blockNumber', [])).result)
  const from = head - BigInt(span) + 1n
  // Retry only on rate limiting so that a range limit shows up as a hard error.
  for (let i = 0; i < 6; i++) {
    const r = await rpc('eth_getLogs', [{ address: MARKET, fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16) }])
    if (r.error && /rate limit/i.test(r.error.message)) {
      await sleep(3000 * (i + 1))
      continue
    }
    return r
  }
  return { error: { code: -1, message: 'rate limited on every attempt' } }
}

describe('Arc Testnet RPC log limits vs app chunk sizes', () => {
  for (const span of [2_000, 5_000, 10_000]) {
    test(`eth_getLogs over ${span} blocks succeeds`, async () => {
      await sleep(1500)
      const r = await getLogsRange(span)
      if (r.error) console.log(`span ${span}:`, r.error)
      else console.log(`span ${span}: ${r.result.length} logs`)
      expect(r.error).toBeUndefined()
    }, 60_000)
  }
})
