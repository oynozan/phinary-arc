/**
 * Keeper end-to-end on anvil: price push heartbeat/deviation, near-expiry pushes, oracle pokes,
 * bad source prices, setup re-runs.
 * Run: bun test tests/keeper/prices.e2e.test.ts   (needs `forge build` first)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Chain, KEYS, aggregatorAbi, marketAbi, oracleAbi, until } from './harness'

async function latestRound(chain: Chain, asset: number) {
  return chain.pub.readContract({ address: chain.addrs.feeds[asset], abi: aggregatorAbi, functionName: 'latestRoundData' })
}

describe('price push + poke', () => {
  const chain = new Chain()
  /** The running keeper; started (and its markets awaited) by whichever test runs first. */
  async function keeper() {
    if (chain.keepers.length === 0) {
      chain.startKeeper()
      expect(await until(async () => (await chain.markets()).length >= 9, 30_000)).toBe(true)
    }
    return chain.keepers[0]
  }
  beforeAll(async () => {
    await chain.start()
    await chain.deployAll()
    const s = await chain.runScript('scripts/setup.ts')
    if (s.code !== 0) throw new Error(`setup failed: ${s.err}`)
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  test('deviation: 1.5 bps does not push, 2 bps pushes; heartbeat pushes after 45s', async () => {
    const k = await keeper()
    const r0 = (await latestRound(chain, 0))[0]
    chain.setPrice('BTC-USD', '67010.05') // +1.5 bps
    await Bun.sleep(2500)
    expect((await latestRound(chain, 0))[0]).toBe(r0)
    chain.setPrice('BTC-USD', '67013.4') // +2.0 bps
    expect(await until(async () => (await latestRound(chain, 0))[0] === r0 + 1n, 10_000)).toBe(true)
    expect((await latestRound(chain, 0))[1]).toBe(6_701_340_000_000n)
    const e0 = (await latestRound(chain, 1))[0]
    await chain.advance(46)
    expect(await until(async () => (await latestRound(chain, 1))[0] === e0 + 1n, 10_000)).toBe(true)
    expect(k.exited).toBe(false)
  }, 60_000)

  test('regression: the oracle is poked about every POKE_INTERVAL_S = 60s, not only on heartbeat pushes', async () => {
    await keeper()
    const t0 = await chain.chainTime()
    const b0 = await chain.pub.getBlockNumber()
    for (let i = 0; i < 40; i++) {
      await chain.advance(15)
      await Bun.sleep(2500)
    }
    const t1 = await chain.chainTime()
    const logs = await chain.pub.getContractEvents({
      address: chain.addrs.oracle,
      abi: oracleAbi,
      eventName: 'ObservationRecorded',
      args: { assetId: 0 },
      fromBlock: b0 + 1n,
    })
    const ts = logs.map((l) => Number(l.args.timestamp))
    const gaps = ts.slice(1).map((t, i) => t - ts[i])
    // each advance step is ~17.5s of chain time, so a 60s poke lands on the 4th step at the latest
    expect(Math.max(...gaps)).toBeLessThanOrEqual(80)
    expect(logs.length).toBeGreaterThanOrEqual(Math.floor((t1 - t0) / 80))
  }, 240_000)

  test('near expiry every price change is pushed, and the age rule keeps trading open', async () => {
    await keeper()
    const now = await chain.chainTime()
    const m = (await chain.markets())
      .filter((x) => x.status === 0 && x.assetId === 0 && x.expiry > now + 90)
      .sort((a, b) => a.expiry - b.expiry)[0]
    await chain.advance(m.expiry - now - 90)
    const r0 = (await latestRound(chain, 0))[0]
    const p0 = Number((await latestRound(chain, 0))[1]) / 1e8
    const p1 = (p0 * 1.00005).toFixed(2) // +0.5 bps, below the 2 bps deviation
    chain.setPrice('BTC-USD', p1)
    // pushed within a tick or two, before the age rule alone would push it
    expect(await until(async () => (await latestRound(chain, 0))[1] === BigInt(Math.round(Number(p1) * 1e8)), 4_000)).toBe(true)
    expect((await latestRound(chain, 0))[0]).toBeGreaterThan(r0)
    // 30s left: a price 30s old is too old (age * 4 > time left) until the keeper pushes again
    await chain.advance(m.expiry - (await chain.chainTime()) - 30)
    const buyable = async () => {
      const q = await chain.pub.readContract({ address: chain.addrs.market, abi: marketAbi, functionName: 'quote', args: [m.id] })
      return q[1] + q[3] > 0n // buyUp or buyDown executable
    }
    expect(await until(buyable, 10_000)).toBe(true)
  }, 60_000)

  test('regression: a 20%+ jump is held for one tick and pushed once the next tick confirms it', async () => {
    const k = await keeper()
    const p0 = Number((await latestRound(chain, 2))[1]) / 1e8
    const jumped = (p0 * 1.25).toFixed(2)
    chain.setPrice('SOL-USD', jumped)
    expect(await k.waitFor(/price push SOL held/, 10_000)).toBe(true)
    expect(await until(async () => (await latestRound(chain, 2))[1] === BigInt(Math.round(Number(jumped) * 1e8)), 10_000)).toBe(true)
    chain.setPrice('SOL-USD', '150')
    expect(await until(async () => (await latestRound(chain, 2))[1] === 15_000_000_000n, 10_000)).toBe(true)
  }, 60_000)

  test('a non-numeric Coinbase price is rejected without crashing the loop', async () => {
    const k = await keeper()
    const r0 = (await latestRound(chain, 2))[0]
    chain.setPrice('SOL-USD', 'not-a-number')
    expect(await k.waitFor(/price push SOL failed/, 10_000)).toBe(true)
    expect((await latestRound(chain, 2))[0]).toBe(r0)
    chain.setPrice('SOL-USD', '150')
    expect(k.exited).toBe(false)
  }, 30_000)

  test('regression: a zero Coinbase price is never pushed, so a market expiring then still settles', async () => {
    const k = await keeper()
    const now = BigInt(await chain.chainTime())
    const ms = await chain.markets()
    // the ETH market expiring soonest
    const target = ms
      .filter((m) => m.status === 0 && m.assetId === 1 && BigInt(m.expiry) > now)
      .sort((a, b) => Number(a.expiry) - Number(b.expiry))[0]
    const r0 = (await latestRound(chain, 1))[0]
    chain.setPrice('ETH-USD', '0')
    await chain.advance(Number(BigInt(target.expiry) - now) + 1)
    expect(await k.waitFor(/price push ETH failed: Coinbase ETH-USD ticker returned a non-positive price/, 10_000)).toBe(true)
    expect((await latestRound(chain, 1))[0]).toBe(r0)
    chain.setPrice('ETH-USD', '3500')
    await chain.advance(50)
    expect(await until(async () => (await chain.markets())[Number(target.id) - 1].status === 1, 10_000)).toBe(true)
  }, 60_000)
})

describe('setup.ts re-run', () => {
  const chain = new Chain()
  beforeAll(async () => {
    await chain.start()
    await chain.deployAll()
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  test('re-running setup keeps realized-vol history and the deposit; SETUP_FORCE=1 re-registers (documented)', async () => {
    expect((await chain.runScript('scripts/setup.ts')).code).toBe(0)
    const k = chain.startKeeper()
    expect(await until(async () => (await chain.markets()).length >= 9, 30_000)).toBe(true)
    k.stop()
    for (let i = 0; i < 3; i++) {
      await chain.advance(61)
      await chain.tx(KEYS.alice, { address: chain.addrs.oracle, abi: oracleAbi, functionName: 'poke', args: [0] })
    }
    const count = () => chain.pub.readContract({ address: chain.addrs.oracle, abi: oracleAbi, functionName: 'getObservationCount', args: [0] })
    const before = await count()
    expect(before).toBeGreaterThan(0n)
    const r = await chain.runScript('scripts/setup.ts')
    expect(r.code).toBe(0)
    expect(r.out).toContain('BTC: already registered')
    expect(r.out).toContain('deposit skipped')
    expect(await count()).toBe(before)
    const forced = await chain.runScript('scripts/setup.ts', { SETUP_FORCE: '1' })
    expect(forced.code).toBe(0)
    expect(await count()).toBe(0n)
    // markets created before the forced re-run are still tradable (feed address unchanged)
    const now = await chain.chainTime()
    const m = (await chain.markets()).find((x) => x.status === 0 && x.expiry > now + 120)!
    const q = await chain.pub.readContract({ address: chain.addrs.market, abi: marketAbi, functionName: 'quote', args: [m.id] })
    expect(q[1]).toBeGreaterThan(0n)
  }, 120_000)
})
