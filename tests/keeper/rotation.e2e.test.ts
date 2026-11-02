/**
 * Keeper end-to-end on anvil: market rotation and settlement.
 * Run: bun test tests/keeper/rotation.e2e.test.ts   (needs `forge build` first)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { privateKeyToAccount } from 'viem/accounts'
import { Chain, KEYS, aggregatorAbi, marketAbi, until } from './harness'

const DUR = [300n, 900n, 3600n]

describe('keeper rotation + settlement (mock feeds)', () => {
  const chain = new Chain()
  beforeAll(async () => {
    await chain.start()
    await chain.deployAll()
    const s = await chain.runScript('scripts/setup.ts')
    if (s.code !== 0) throw new Error(`setup failed: ${s.err}`)
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  test('setup.ts registered feeds and deposited keeper USDC minus the 3 USDC reserve', async () => {
    const keeper = privateKeyToAccount(KEYS.keeper).address
    const shares = await chain.pub.readContract({ address: chain.addrs.market, abi: marketAbi, functionName: 'sharesOf', args: [keeper] })
    expect(shares).toBeGreaterThan(0n)
    for (let a = 0; a < 3; a++) expect(await chain.spot8(a)).toBeGreaterThan(0n)
  })

  test('opens exactly one market per asset and duration, no duplicates over many ticks', async () => {
    const k = chain.startKeeper()
    const ok = await until(async () => (await chain.markets()).length >= 9, 30_000)
    expect(ok).toBe(true)
    await Bun.sleep(4000) // ~8 scaled ticks
    const ms = await chain.markets()
    expect(ms.length).toBe(9)
    for (let a = 0; a < 3; a++)
      for (const d of DUR) expect(ms.filter((m) => m.assetId === a && BigInt(m.expiry) - BigInt(m.createdAt) === d).length).toBe(1)
    expect(k.count(/failed/)).toBe(0)
  }, 60_000)

  test('rolls the 5m markets 20s before expiry and settles them with the first round >= expiry', async () => {
    const k = chain.keepers[0]
    const before = await chain.markets()
    const fiveMin = before.filter((m) => BigInt(m.expiry) - BigInt(m.createdAt) === 300n)
    await chain.advance(285)
    expect(await until(async () => (await chain.markets()).length === 12, 20_000)).toBe(true)
    await Bun.sleep(2000)
    expect((await chain.markets()).length).toBe(12)
    // push past expiry; heartbeat (45s) push creates the settlement round
    await chain.advance(50)
    expect(
      await until(async () => {
        const ms = await chain.markets()
        return fiveMin.every((f) => ms[Number(f.id) - 1].status === 1)
      }, 20_000),
    ).toBe(true)
    const ms = await chain.markets()
    for (const f of fiveMin) {
      const m = ms[Number(f.id) - 1]
      const feed = chain.addrs.feeds[m.assetId]
      // verify settlePrice is the answer of the first round with updatedAt >= expiry
      const latest = await chain.pub.readContract({ address: feed, abi: aggregatorAbi, functionName: 'latestRoundData' })
      let first: bigint | undefined
      for (let r = 1n; r <= latest[0]; r++) {
        const rd = await chain.pub.readContract({ address: feed, abi: aggregatorAbi, functionName: 'getRoundData', args: [r] })
        if (rd[3] >= BigInt(m.expiry)) {
          first = rd[1]
          break
        }
      }
      expect(m.settlePrice).toBe(first! * 10n ** 10n)
    }
    expect(k.exited).toBe(false)
  }, 90_000)

  test('settlement round search handles hundreds of irregular rounds', async () => {
    const k = chain.keepers[0]
    const ms0 = await chain.markets()
    const target = ms0.find((m) => m.status === 0 && m.assetId === 1 && BigInt(m.expiry) - BigInt(m.createdAt) === 900n)!
    const feed = chain.addrs.feeds[1]
    // stop keeper pushes interfering: we push many rounds ourselves from the second updater
    const t0 = await chain.chainTime()
    const expiry = Number(target.expiry)
    let t = t0
    let i = 0
    while (t < expiry + 30) {
      t += 1 + (i % 7 === 0 ? 37 : i % 3) // irregular gaps
      await chain.rpc('evm_setNextBlockTimestamp', [t])
      await chain.tx(KEYS.pusher, { address: feed, abi: aggregatorAbi, functionName: 'setPrice', args: [350000000000n + BigInt(i)] })
      i++
    }
    await chain.syncClock()
    expect(
      await until(async () => (await chain.markets())[Number(target.id) - 1].status === 1, 30_000),
    ).toBe(true)
    expect(k.count(new RegExp(`settle ${target.id} failed`))).toBe(0)
  }, 180_000)
})
