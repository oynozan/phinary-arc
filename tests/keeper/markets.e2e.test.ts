/**
 * Keeper end-to-end on anvil: which markets the keeper considers, Chainlink-style round ids,
 * recovery from failed creates, several instances, and setup.ts re-runs.
 * Run: bun test tests/keeper/markets.e2e.test.ts   (needs `forge build` first)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { parseUnits, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Chain, KEYS, VOL, marketAbi, oracleAbi, phasedAbi, until } from './harness'

async function freshChain() {
  const chain = new Chain()
  await chain.start()
  await chain.deployAll()
  const s = await chain.runScript('scripts/setup.ts')
  if (s.code !== 0) throw new Error(`setup failed: ${s.err}`)
  return chain
}

const isAtm = (strike: bigint, spot: bigint) => (strike > spot ? strike - spot : spot - strike) * 10_000n <= spot // within 1 bp

describe('custom-strike markets vs keeper rotation', () => {
  let chain: Chain
  beforeAll(async () => {
    chain = await freshChain()
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  test('regression: a user-created 9% OTM market does not stop the keeper from opening the rolling ATM market', async () => {
    const spot = await chain.spot8(0)
    const otm = spot + (spot * 9n) / 100n
    await chain.tx(KEYS.bob, { address: chain.addrs.market, abi: marketAbi, functionName: 'createMarket', args: [0, otm, 300] })
    chain.startKeeper()
    expect(await until(async () => (await chain.markets()).length >= 10, 30_000)).toBe(true)
    await Bun.sleep(3000)
    const ms = await chain.markets()
    const btc5 = ms.filter((m) => m.assetId === 0 && m.status === 0 && BigInt(m.expiry) - BigInt(m.createdAt) === 300n)
    // intended: the keeper keeps a rolling at-the-money market for every asset and duration
    expect(btc5.some((m) => isAtm(m.strike, spot))).toBe(true)
    expect(ms.length).toBe(10)
  }, 60_000)
})

describe('keeper only looks at the latest 120 markets', () => {
  let chain: Chain
  beforeAll(async () => {
    chain = await freshChain()
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  test('regression: an expired market older than the last 120 created is still settled by the keeper', async () => {
    chain.startKeeper()
    expect(await until(async () => (await chain.markets()).length >= 9, 30_000)).toBe(true)
    const target = (await chain.markets()).find((m) => m.assetId === 0 && BigInt(m.expiry) - BigInt(m.createdAt) === 300n)!
    await chain.tx(KEYS.alice, { address: chain.addrs.market, abi: marketAbi, functionName: 'buy', args: [target.id, true, parseUnits('10', 6), parseUnits('10', 6)] })
    // 120 custom-strike markets (BuyForm opens one for every new custom strike; anyone can call createMarket)
    const spot = await chain.spot8(1)
    for (let i = 0; i < 120; i++) {
      await chain.tx(KEYS.bob, { address: chain.addrs.market, abi: marketAbi, functionName: 'createMarket', args: [1, spot + BigInt(i + 1) * 10n ** 18n, 3600] })
    }
    await chain.advance(310) // past expiry; keeper pushes the settlement round
    await Bun.sleep(5000)
    await chain.advance(50)
    expect(await until(async () => (await chain.markets())[Number(target.id) - 1].status === 1, 10_000)).toBe(true)
  }, 180_000)
})

describe('Chainlink-style (phase-encoded) round ids', () => {
  let chain: Chain
  let phased: Address
  let lastTarget = 0n
  const statusOf = async (id: bigint) => (await chain.markets())[Number(id) - 1].status
  const push = (price: bigint) => chain.tx(KEYS.bob, { address: phased, abi: phasedAbi, functionName: 'setPrice', args: [price] })
  const latestRound = async () => (await chain.pub.readContract({ address: phased, abi: phasedAbi, functionName: 'latestRoundData' }))[0]
  const btc5m = (m: { assetId: number; expiry: number; createdAt: number }) => m.assetId === 0 && BigInt(m.expiry) - BigInt(m.createdAt) === 300n
  /** The newest BTC 5m market after `after`, once the (restarted) keeper has opened it. */
  async function nextBtc5m(after: bigint) {
    expect(await until(async () => (await chain.markets()).some((m) => m.id > after && btc5m(m)), 30_000)).toBe(true)
    return (await chain.markets()).filter((m) => m.id > after && btc5m(m)).at(-1)!
  }
  /** Stop the keeper and move the chain just past `expiry`, so no keeper push lands in between. */
  async function stopAndExpire(expiry: number) {
    chain.keepers.at(-1)!.stop()
    await Bun.sleep(300)
    await chain.advance(expiry - (await chain.chainTime()) + 1)
  }
  beforeAll(async () => {
    chain = await freshChain()
    phased = await chain.deploy(KEYS.keeper, 'KeeperHarnessMocks.sol', 'PhasedAggregator', [])
    await chain.tx(KEYS.keeper, { address: phased, abi: phasedAbi, functionName: 'setPrice', args: [67_000n * 10n ** 8n] })
    // AGENTS.md: "swap the mocks with oracle.setFeed(assetId, realFeed, ...)"
    await chain.tx(KEYS.keeper, {
      address: chain.addrs.oracle,
      abi: oracleAbi,
      functionName: 'setFeed',
      args: [0, phased, 600, parseUnits('0.30', 18), parseUnits('1.5', 18), parseUnits('0.55', 18)],
    })
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  test('regression: keeper settles markets on a feed whose round ids are (phaseId << 64) | n', async () => {
    // VITE_FEED_BTC still names the old mock: the keeper follows the oracle's FeedSet event instead
    const k = chain.startKeeper()
    expect(await until(async () => (await chain.markets()).length >= 9, 30_000)).toBe(true)
    const target = (await chain.markets()).find(btc5m)!
    await chain.advance(310)
    await Bun.sleep(4000)
    await chain.advance(50)
    expect(await until(async () => (await statusOf(target.id)) === 1, 10_000)).toBe(true)
    expect(k.count(new RegExp(`settle ${target.id} failed`))).toBe(0)
    expect((await latestRound()) >> 64n).toBe(1n)
    lastTarget = target.id
  }, 90_000)

  test('a post-expiry round left in the previous phase still settles the market', async () => {
    const target = await nextBtc5m(lastTarget)
    await stopAndExpire(target.expiry)
    await push(67_100n * 10n ** 8n) // phase 1: the first round at or after expiry
    const settleRound = await latestRound()
    await chain.tx(KEYS.bob, { address: phased, abi: phasedAbi, functionName: 'newPhase', args: [] })
    await push(67_200n * 10n ** 8n) // phase 2, round 1
    const k = chain.startKeeper()
    expect(await until(async () => (await statusOf(target.id)) === 1, 20_000)).toBe(true)
    expect((await chain.markets())[Number(target.id) - 1].settlePrice).toBe(67_100n * 10n ** 18n)
    expect(settleRound >> 64n).toBe(1n)
    expect(k.count(new RegExp(`settle ${target.id} failed`))).toBe(0)
    lastTarget = target.id
  }, 90_000)

  test('a market whose first post-expiry round opens a new phase is skipped, then voided after 24h', async () => {
    const target = await nextBtc5m(lastTarget)
    await stopAndExpire(target.expiry)
    await chain.tx(KEYS.bob, { address: phased, abi: phasedAbi, functionName: 'newPhase', args: [] })
    await push(67_300n * 10n ** 8n) // phase 3, round 1: the adapter rejects it (PhaseBoundaryRound)
    const k = chain.startKeeper()
    const skipped = new RegExp(`market ${target.id} cannot settle`)
    expect(await k.waitFor(skipped, 20_000)).toBe(true)
    await Bun.sleep(2000)
    expect(await statusOf(target.id)).toBe(0)
    expect(k.count(skipped)).toBe(1) // logged once, not searched again every tick
    expect(k.count(new RegExp(`settle ${target.id} failed`))).toBe(0)
    await chain.advance(86_400)
    expect(await until(async () => (await statusOf(target.id)) === 2, 20_000)).toBe(true)
  }, 120_000)
})

describe('recovery from failed creates', () => {
  let chain: Chain
  beforeAll(async () => {
    chain = await freshChain()
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  test('stale oracle blocks creates; after the price source recovers exactly one market per slot', async () => {
    const k = chain.startKeeper()
    expect(await until(async () => (await chain.markets()).length >= 9, 30_000)).toBe(true)
    chain.ctl.status['BTC-USD'] = 503
    chain.writeCtl()
    await chain.advance(300) // BTC feed is now stale (>120s); 5m slots need replacing
    expect(await k.waitFor(/create BTC 300s failed/, 15_000)).toBe(true)
    expect(k.count(/price push BTC failed/)).toBeGreaterThan(0)
    delete chain.ctl.status['BTC-USD']
    chain.writeCtl()
    expect(await k.waitFor(/opened BTC 300s market/, 15_000, 2)).toBe(true)
    await Bun.sleep(2500)
    const now = BigInt(await chain.chainTime())
    const ms = await chain.markets()
    for (let a = 0; a < 3; a++)
      for (const d of [300n, 900n, 3600n]) {
        const live = ms.filter((m) => m.assetId === a && m.status === 0 && BigInt(m.expiry) - BigInt(m.createdAt) === d && BigInt(m.expiry) > now + 20n)
        expect(live.length).toBe(1)
      }
    expect(k.exited).toBe(false)
  }, 90_000)
})

describe('two keeper instances (MAINNET_MIGRATION.md: "run at least two instances")', () => {
  let chain: Chain
  beforeAll(async () => {
    chain = await freshChain()
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  test('regression: two keepers splitting the slots (KEEPER_INDEX / KEEPER_COUNT) open one market per slot', async () => {
    // second instance uses its own signer; market creation is permissionless
    const addr = (k: Hex) => privateKeyToAccount(k).address
    chain.startKeeper({ KEEPER_INDEX: '0', KEEPER_COUNT: '2', KEEPER_PEERS: addr(KEYS.pusher) })
    chain.startKeeper({ KEEPER_PRIVATE_KEY: KEYS.pusher, KEEPER_INDEX: '1', KEEPER_COUNT: '2', KEEPER_PEERS: addr(KEYS.keeper) })
    await until(async () => (await chain.markets()).length >= 9, 30_000)
    await Bun.sleep(4000)
    const ms = await chain.markets()
    const slots = new Map<string, number>()
    for (const m of ms) {
      const key = `${m.assetId}:${BigInt(m.expiry) - BigInt(m.createdAt)}`
      slots.set(key, (slots.get(key) ?? 0) + 1)
    }
    expect([...slots.values()]).toEqual(Array(9).fill(1))
    // both instances took their share
    const created = await chain.pub.getContractEvents({ address: chain.addrs.market, abi: marketAbi, eventName: 'MarketCreated', fromBlock: 0n })
    expect(new Set(created.map((l) => l.args.creator)).size).toBe(2)
  }, 60_000)
})

describe('same signer used concurrently (keeper + setup.ts re-run)', () => {
  let chain: Chain
  beforeAll(async () => {
    chain = await freshChain()
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  test('regression: re-running setup.ts while the keeper is live sends nothing, so it cannot race the nonce', async () => {
    const k = chain.startKeeper()
    await until(async () => (await chain.markets()).length >= 3, 30_000)
    const r = await chain.runScript('scripts/setup.ts')
    expect(r.code).toBe(0)
    expect(r.out).toContain('already registered')
    expect(r.out).toContain('deposit skipped')
    await Bun.sleep(3000)
    expect(k.lines.filter((l) => /nonce|underpriced|already known/i.test(l)).length).toBe(0)
    expect(k.exited).toBe(false)
  }, 90_000)
})

describe('setup.ts after the deploy script registered the feeds', () => {
  let chain: Chain
  beforeAll(async () => {
    chain = new Chain()
    await chain.start()
    await chain.deployAll()
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  test('regression: registered mock feeds with no round yet are still seeded, and not re-registered', async () => {
    // what DeployPhinary.s.sol does on testnet: register every feed, push no price
    for (const [i, f] of chain.addrs.feeds.entries()) {
      const [min, max, def] = VOL[i].map((v) => parseUnits(v, 18))
      await chain.tx(KEYS.keeper, { address: chain.addrs.oracle, abi: oracleAbi, functionName: 'setFeed', args: [i, f, 600, min, max, def] })
    }
    const s = await chain.runScript('scripts/setup.ts')
    expect(s.code).toBe(0)
    expect(s.out).toContain('BTC: feed seeded at 67000 (already registered)')
    expect(s.out).toContain('SOL: feed seeded at 150 (already registered)')
    expect(await chain.spot8(0)).toBe(67_000n * 10n ** 18n)
    const feedSets = await chain.pub.getContractEvents({ address: chain.addrs.oracle, abi: oracleAbi, eventName: 'FeedSet', fromBlock: 0n })
    expect(feedSets.length).toBe(3)
    // a second run finds the rounds and skips every feed
    const again = await chain.runScript('scripts/setup.ts')
    expect(again.out.match(/already registered, skipped/g)?.length).toBe(3)
  }, 90_000)
})
