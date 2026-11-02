// src/lib/realtime.ts queues one-off reads 8 at a time because Arc's RPC rejects ~20 in flight.
import '../unit/setup'
import { afterAll, expect, test } from 'bun:test'
import { rpc, wsClient } from '@/lib/realtime'

const client = wsClient as unknown as Record<string, unknown>
const saved = { readContract: client.readContract, getBlockNumber: client.getBlockNumber }
afterAll(() => Object.assign(client, saved))

test('never more than 8 queued reads in flight, including when new reads arrive as others finish', async () => {
  let inFlight = 0
  let max = 0
  client.readContract = async () => {
    inFlight++
    max = Math.max(max, inFlight)
    await new Promise((r) => setTimeout(r, 1 + Math.random() * 5))
    inFlight--
    return 1n
  }
  const jobs: Promise<unknown>[] = []
  for (let i = 0; i < 40; i++) jobs.push(rpc.readContract({} as never))
  // Bursts that land while earlier reads are completing.
  for (let k = 0; k < 20; k++) {
    await new Promise((r) => setTimeout(r, 2))
    for (let i = 0; i < 5; i++) jobs.push(rpc.readContract({} as never))
  }
  await Promise.all(jobs)
  expect(max).toBeLessThanOrEqual(8)
})

test('a failing read releases its slot', async () => {
  client.getBlockNumber = async () => {
    throw new Error('boom')
  }
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => rpc.getBlockNumber()))
  expect(results.every((r) => r.status === 'rejected')).toBe(true)
  client.getBlockNumber = async () => 5n
  expect(await rpc.getBlockNumber()).toBe(5n)
})
