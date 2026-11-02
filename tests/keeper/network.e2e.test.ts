/**
 * Keeper end-to-end on anvil for the NVDA/AAPL assets, mainnet mode (Chainlink Data Streams reports on
 * StreamsFeed) and the multi-instance / RPC-failure / slow-scan follow-ups.
 * Run: bun test tests/keeper/network.e2e.test.ts   (needs `forge build` first)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { decodeAbiParameters, decodeFunctionData, keccak256, parseUnits, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ASSET_KEYS, Chain, KEYS, STREAMS_SECRET, STREAM_IDS, aggregatorAbi, marketAbi, oracleAbi, streamsFeedAbi, streamsFullReport, until } from './harness'

const addr = (k: Hex) => privateKeyToAccount(k).address
const dur = (m: { expiry: number; createdAt: number }) => BigInt(m.expiry) - BigInt(m.createdAt)
const DISPUTE_PERIOD = 300 // StreamsFeed.DISPUTE_PERIOD
/** keccak256 of the report data: StreamsFeed's same-second settlement tie-break. */
const reportHash = (full: Hex) =>
  keccak256(decodeAbiParameters([{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }], full)[1])

async function settlement(chain: Chain, asset: number, expiry: number) {
  return chain.pub.readContract({ address: chain.addrs.feeds[asset], abi: streamsFeedAbi, functionName: 'settlements', args: [BigInt(expiry)] })
}

async function latestRound(chain: Chain, asset: number) {
  return chain.pub.readContract({ address: chain.addrs.feeds[asset], abi: aggregatorAbi, functionName: 'latestRoundData' })
}

/** Answer of the first round at or after `expiry` (round ids are contiguous from 1 on both feed types). */
async function firstRoundAtOrAfter(chain: Chain, feed: Address, expiry: bigint) {
  const [latest] = await chain.pub.readContract({ address: feed, abi: aggregatorAbi, functionName: 'latestRoundData' })
  for (let r = 1n; r <= latest; r++) {
    const rd = await chain.pub.readContract({ address: feed, abi: aggregatorAbi, functionName: 'getRoundData', args: [r] })
    if (rd[3] >= expiry) return rd[1]
  }
  return undefined
}

/** The roundId the market's settle transaction passed. */
async function settleRoundId(chain: Chain, id: bigint) {
  const [l] = await chain.pub.getContractEvents({ address: chain.addrs.market, abi: marketAbi, eventName: 'Settled', args: { marketId: id }, fromBlock: 0n })
  const tx = await chain.pub.getTransaction({ hash: l.transactionHash })
  return decodeFunctionData({ abi: marketAbi, data: tx.input }).args?.[1]
}

/** One rolling market per asset and duration among the open ones. */
function expectOnePerSlot(ms: Awaited<ReturnType<Chain['markets']>>, assets: number) {
  expect(ms.length).toBe(assets * 3)
  for (let a = 0; a < assets; a++)
    for (const d of [300n, 900n, 3600n]) expect(ms.filter((m) => m.assetId === a && dur(m) === d).length).toBe(1)
}

/**
 * Advance past the expiry of every open 5m market of these assets and wait until they all settled: testnet on the first
 * round at or after expiry; mainnet (StreamsFeed) with roundId 0 on the report observed at expiry, priced from `atExpiry`,
 * once its record is past DISPUTE_PERIOD.
 */
async function settleFiveMinute(chain: Chain, assets: number[], decimalsTo18: bigint, atExpiry?: Record<string, string>) {
  const five = (await chain.markets()).filter((m) => m.status === 0 && assets.includes(m.assetId) && dur(m) === 300n)
  expect(five.length).toBe(assets.length)
  for (const f of five) if (atExpiry) chain.streamPricesAt[`${ASSET_KEYS[f.assetId]}@${f.expiry}`] = atExpiry[ASSET_KEYS[f.assetId]]
  const last = Math.max(...five.map((m) => m.expiry))
  const count = (await chain.markets()).length
  await chain.advance(last - (await chain.chainTime()) + 1)
  if (atExpiry) {
    // the tick that stores the records also reopens the 5m slots; jumping time before it ends would make it create
    // markets on a stale oracle, so wait for both
    expect(await until(async () =>
      (await chain.markets()).length >= count + five.length &&
      (await Promise.all(five.map((f) => settlement(chain, f.assetId, f.expiry)))).every((r) => r[2] !== 0), 30_000)).toBe(true)
    await chain.advance(DISPUTE_PERIOD)
  }
  expect(await until(async () => {
    const ms = await chain.markets()
    return five.every((f) => ms[Number(f.id) - 1].status === 1)
  }, 30_000)).toBe(true)
  const ms = await chain.markets()
  for (const f of five) {
    if (atExpiry) {
      expect(ms[Number(f.id) - 1].settlePrice).toBe(parseUnits(atExpiry[ASSET_KEYS[f.assetId]], 18))
      expect(await settleRoundId(chain, f.id)).toBe(0n)
      continue
    }
    const first = await firstRoundAtOrAfter(chain, chain.addrs.feeds[f.assetId], BigInt(f.expiry))
    expect(ms[Number(f.id) - 1].settlePrice).toBe(first! * decimalsTo18)
  }
}

describe('NVDA and AAPL on testnet (Kraken xStocks prices)', () => {
  const chain = new Chain({ stocks: true })
  beforeAll(async () => {
    await chain.start()
    await chain.deployAll()
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  test('setup seeds NVDA/AAPL at the Kraken mid; the keeper opens one market per slot for all five assets', async () => {
    const s = await chain.runScript('scripts/setup.ts')
    expect(s.code).toBe(0)
    expect(s.out).toContain('NVDA: feed seeded at 204.415 and registered')
    expect(s.out).toContain('AAPL: feed seeded at 343.3 and registered')
    expect((await latestRound(chain, 3))[1]).toBe(20_441_500_000n)
    const k = chain.startKeeper()
    expect(await until(async () => (await chain.markets()).length >= 15, 40_000)).toBe(true)
    await Bun.sleep(3000)
    expectOnePerSlot(await chain.markets(), 5)
    expect(k.count(/failed/)).toBe(0)
  }, 90_000)

  test('a wide or crossed Kraken quote is never pushed; the other stock still is', async () => {
    const k = chain.keepers[0]
    const nvda0 = (await latestRound(chain, 3))[0]
    const aapl0 = (await latestRound(chain, 4))[0]
    chain.kraken.NVDAxUSD = { bid: '200', ask: '210' }
    await chain.advance(46) // heartbeat due
    expect(await k.waitFor(/price push NVDA failed: Kraken NVDAxUSD spread too wide/, 10_000)).toBe(true)
    chain.kraken.NVDAxUSD = { bid: '204.50', ask: '204.40' }
    expect(await k.waitFor(/price push NVDA failed: Kraken NVDAxUSD ticker is crossed/, 10_000)).toBe(true)
    expect((await latestRound(chain, 3))[0]).toBe(nvda0)
    expect(await until(async () => (await latestRound(chain, 4))[0] > aapl0, 10_000)).toBe(true)
    chain.kraken.NVDAxUSD = { bid: '204.41', ask: '204.42' }
    expect(await until(async () => (await latestRound(chain, 3))[0] > nvda0, 10_000)).toBe(true)
  }, 60_000)

  test('NVDA/AAPL 5m markets settle with the first round at or after expiry', async () => {
    await settleFiveMinute(chain, [3, 4], 10n ** 10n)
  }, 90_000)
})

describe('mainnet: signed Data Streams reports on StreamsFeed', () => {
  const chain = new Chain({ network: 'mainnet' })
  beforeAll(async () => {
    await chain.start()
    await chain.deployAll()
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  test('setup.ts only verifies the feeds (one report each), and deposits only with DEPOSIT_USDC', async () => {
    const shares = () => chain.pub.readContract({ address: chain.addrs.market, abi: marketAbi, functionName: 'sharesOf', args: [addr(KEYS.keeper)] })
    const s = await chain.runScript('scripts/setup.ts')
    expect(s.code).toBe(0)
    expect(s.out).toContain('BTC: BTC / USD ok, 67000 at')
    expect(s.out).toContain('NVDA: NVDA / USD ok, 204.415 at')
    expect(s.out).toContain('Mainnet: no deposit')
    expect(await shares()).toBe(0n)
    for (let a = 0; a < 5; a++) expect((await latestRound(chain, a))[0]).toBe(1n)
    // a feed deployed for another stream fails the check
    const bad = await chain.runScript('scripts/setup.ts', { STREAMS_FEED_ID_SOL: `0x0003${'11'.repeat(30)}` })
    expect(bad.code).not.toBe(0)
    expect(bad.err).toContain('SOL')
    expect(bad.err).toMatch(/stream 0x0003b778/)
    const d = await chain.runScript('scripts/setup.ts', { DEPOSIT_USDC: '50000' })
    expect(d.code).toBe(0)
    expect(d.out).toContain('Deposited 50000 USDC into the vault')
    expect(await shares()).toBeGreaterThan(0n)
    expect(chain.streamsRequests.unauthorized).toBe(0)
  }, 120_000)

  test('regression: setup reports a latest report past maxReportAge on inclusion for every feed instead of crashing on the first', async () => {
    chain.streamsLag = 6 // StaleReport on submit
    const s = await chain.runScript('scripts/setup.ts')
    chain.streamsLag = 0
    expect(s.code).not.toBe(0)
    for (const key of ASSET_KEYS) expect(s.err).toMatch(new RegExp(`${key} \\(0x[0-9a-fA-F]{40}\\): latest Data Streams report would be \\d+s old on inclusion \\(maxReportAge 5s\\)`))
    expect(s.err).not.toContain('StaleReport')
  }, 60_000)

  test('the keeper submits reports, opens 15 markets, follows deviations and settles on the report observed at expiry (roundId 0)', async () => {
    const k = chain.startKeeper()
    expect(await until(async () => (await chain.markets()).length >= 15, 60_000)).toBe(true)
    await Bun.sleep(3000)
    expectOnePerSlot(await chain.markets(), 5)
    const r0 = (await latestRound(chain, 0))[0]
    chain.streamPrices.BTC = '67100' // +15 bps
    expect(await until(async () => (await latestRound(chain, 0))[1] === 67_100n * 10n ** 18n, 15_000)).toBe(true)
    expect((await latestRound(chain, 0))[0]).toBeGreaterThan(r0)
    // the report at expiry differs from the latest trading round, so the settle price shows which one was used
    await settleFiveMinute(chain, [0, 1, 2, 3, 4], 1n, { BTC: '67250.5', ETH: '3512', SOL: '151.25', NVDA: '205.5', AAPL: '344.75' })
    expect(chain.streamsRequests.unauthorized).toBe(0)
    expect(k.count(/failed/)).toBe(0)
    expect(k.lines.some((l) => l.includes(STREAMS_SECRET))).toBe(false)
  }, 180_000)

  test('a wrong API secret gets 401s and submits nothing; missing credentials stop the keeper at start', async () => {
    chain.keepers[0].stop()
    const r0 = (await latestRound(chain, 0))[0]
    const k = chain.startKeeper({ STREAMS_API_SECRET: 'wrong-secret' })
    await chain.advance(46)
    expect(await k.waitFor(/price push BTC failed: Data Streams report 0x00039d9e failed: 401/, 15_000)).toBe(true)
    expect(chain.streamsRequests.unauthorized).toBeGreaterThan(0)
    expect((await latestRound(chain, 0))[0]).toBe(r0)
    expect(k.lines.some((l) => l.includes('wrong-secret'))).toBe(false)
    k.stop()
    const none = chain.startKeeper({ STREAMS_API_KEY: '' })
    expect(await until(async () => none.exited, 15_000)).toBe(true)
    expect(none.lines.join('\n')).toContain('NETWORK=mainnet needs STREAMS_API_KEY and STREAMS_API_SECRET')
  }, 60_000)

  test('regression: a latest report that would be past maxReportAge (5s) on inclusion is skipped, never submitted', async () => {
    const r0 = (await latestRound(chain, 0))[0]
    chain.streamsLag = 10 // the API serves a report observed 10s ago
    const k = chain.startKeeper()
    await chain.advance(46) // heartbeat due
    expect(await k.waitFor(/price push BTC: report would be 1\ds old on inclusion \(maxReportAge 5s\), skipped/, 15_000)).toBe(true)
    expect((await latestRound(chain, 0))[0]).toBe(r0)
    chain.streamsLag = 0
    expect(await until(async () => (await latestRound(chain, 0))[0] > r0, 15_000)).toBe(true)
    expect(k.count(/price push .*failed/)).toBe(0) // no StaleReport revert
  }, 60_000)

  test('regression: a favorable report from expiry + 8s stored first by someone else is overridden by the report at expiry', async () => {
    const k = chain.keepers.at(-1)!
    const btc5m = async () => {
      const now = await chain.chainTime()
      return (await chain.markets()).find((m) => m.status === 0 && m.assetId === 0 && dur(m) === 300n && m.expiry > now + 30)
    }
    expect(await until(async () => !!(await btc5m()), 30_000)).toBe(true)
    const m = (await btc5m())!
    k.stop()
    await Bun.sleep(300)
    const expiry = BigInt(m.expiry)
    await chain.advance(m.expiry - (await chain.chainTime()) + 9)
    const feed = chain.addrs.feeds[0]
    await chain.tx(KEYS.pusher, {
      address: feed,
      abi: streamsFeedAbi,
      functionName: 'submitSettlement',
      args: [streamsFullReport(STREAM_IDS[0], m.expiry + 8, parseUnits('70000', 18)), expiry],
    })
    expect((await chain.pub.readContract({ address: feed, abi: streamsFeedAbi, functionName: 'settlements', args: [expiry] }))[1]).toBe(m.expiry + 8)
    // not final: nobody can settle on the attacker's price yet
    const early = chain.pub.simulateContract({ address: chain.addrs.market, abi: [...marketAbi, ...streamsFeedAbi], functionName: 'settle', args: [m.id, 0n], account: addr(KEYS.pusher) })
    await expect(early).rejects.toThrow(/SettlementNotFinal/)
    chain.streamPricesAt[`BTC@${m.expiry}`] = '67001.5'
    const k2 = chain.startKeeper()
    expect(await until(async () => (await settlement(chain, 0, m.expiry))[1] === m.expiry, 30_000)).toBe(true)
    await chain.advance(DISPUTE_PERIOD) // from the attacker's first submission
    expect(await until(async () => (await chain.markets())[Number(m.id) - 1].status === 1, 30_000)).toBe(true)
    expect((await chain.markets())[Number(m.id) - 1].settlePrice).toBe(parseUnits('67001.5', 18))
    expect(await settleRoundId(chain, m.id)).toBe(0n)
    expect((await chain.pub.readContract({ address: feed, abi: streamsFeedAbi, functionName: 'settlements', args: [expiry] }))[1]).toBe(m.expiry)
    expect(k2.count(new RegExp(`submitted settlement report ${feed} expiry ${expiry} observed at ${expiry}$`))).toBe(1)
  }, 90_000)

  test('regression: a same-second report stored first by someone else loses to the one with the smaller report hash', async () => {
    const k = chain.keepers.at(-1)!
    const btc5m = async () => {
      const now = await chain.chainTime()
      return (await chain.markets()).find((m) => m.status === 0 && m.assetId === 0 && dur(m) === 300n && m.expiry > now + 30)
    }
    expect(await until(async () => !!(await btc5m()), 30_000)).toBe(true)
    const m = (await btc5m())!
    k.stop()
    await Bun.sleep(300)
    const report = (price: string) => streamsFullReport(STREAM_IDS[0], m.expiry, parseUnits(price, 18))
    const [canonical, other] = BigInt(reportHash(report('67001'))) < BigInt(reportHash(report('66999'))) ? ['67001', '66999'] : ['66999', '67001']
    await chain.advance(m.expiry - (await chain.chainTime()) + 2)
    await chain.tx(KEYS.pusher, { address: chain.addrs.feeds[0], abi: streamsFeedAbi, functionName: 'submitSettlement', args: [report(other), BigInt(m.expiry)] })
    chain.streamPricesAt[`BTC@${m.expiry}`] = canonical // what the keeper's API lookup returns
    chain.startKeeper()
    expect(await until(async () => (await settlement(chain, 0, m.expiry))[3] === reportHash(report(canonical)), 30_000)).toBe(true)
    await chain.advance(DISPUTE_PERIOD)
    expect(await until(async () => (await chain.markets())[Number(m.id) - 1].status === 1, 30_000)).toBe(true)
    expect((await chain.markets())[Number(m.id) - 1].settlePrice).toBe(parseUnits(canonical, 18))
  }, 90_000)

  test('regression: without Data Streams credentials (no pushes) the keeper still voids markets after the void delay', async () => {
    const now = await chain.chainTime()
    const open = (await chain.markets()).filter((m) => m.status === 0 && m.expiry > now + 30) // no settlement record yet
    expect(open.length).toBeGreaterThan(0)
    for (const k of chain.keepers) k.stop()
    await Bun.sleep(300)
    const k = chain.startKeeper({ STREAMS_API_KEY: '', KEEPER_PUSH_PRICES: 'false' })
    await chain.advance(Math.max(...open.map((m) => m.expiry)) - now + 86_400 + 1) // PredictionMarket.VOID_DELAY
    expect(await until(async () => {
      const ms = await chain.markets()
      return open.every((m) => ms[Number(m.id) - 1].status === 2)
    }, 60_000)).toBe(true)
    expect(k.count(/settlement report .* failed: Missing STREAMS_API_KEY/)).toBeGreaterThan(0)
  }, 90_000)
})

async function freshChain() {
  const chain = new Chain()
  await chain.start()
  await chain.deployAll()
  const s = await chain.runScript('scripts/setup.ts')
  if (s.code !== 0) throw new Error(`setup failed: ${s.err}`)
  return chain
}

describe('RPC failures during the settlement round search', () => {
  let chain: Chain
  beforeAll(async () => {
    chain = await freshChain()
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  test('regression: a rate-limited getRoundData is retried, never cached as "cannot settle"', async () => {
    const k = chain.startKeeper()
    expect(await until(async () => (await chain.markets()).length >= 9, 30_000)).toBe(true)
    const target = (await chain.markets()).find((m) => m.assetId === 0 && dur(m) === 300n)!
    let failing = true
    // getRoundData(uint80) = 0x9a6fc8f5
    chain.rpcHook = (msg) =>
      failing && msg.method === 'eth_call' && JSON.stringify(msg.params).includes('0x9a6fc8f5') ? new Response('rate limited', { status: 429 }) : undefined
    await chain.advance(target.expiry - (await chain.chainTime()) + 1)
    expect(await k.waitFor(new RegExp(`settle ${target.id} failed`), 20_000)).toBe(true)
    expect((await chain.markets())[Number(target.id) - 1].status).toBe(0)
    failing = false
    expect(await until(async () => (await chain.markets())[Number(target.id) - 1].status === 1, 20_000)).toBe(true)
    expect(k.count(new RegExp(`market ${target.id} cannot settle`))).toBe(0)
  }, 90_000)
})

describe('slow startup log scan', () => {
  let chain: Chain
  beforeAll(async () => {
    chain = await freshChain()
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  test('regression: the catch-up scan does not hold up pushes or settlement; rotation waits for it', async () => {
    const k1 = chain.startKeeper()
    expect(await until(async () => (await chain.markets()).length >= 9, 30_000)).toBe(true)
    k1.stop()
    await Bun.sleep(300)
    // 15 log chunks of 10k blocks, each getLogs answered 600ms late: a ~9s catch-up
    for (let i = 0; i < 7; i++) await chain.rpc('anvil_mine', ['0x5208', '0x0'])
    chain.rpcHook = async (msg) => {
      if (msg.method === 'eth_getLogs') await Bun.sleep(600)
      return undefined
    }
    const target = (await chain.markets()).find((m) => m.assetId === 0 && dur(m) === 300n)!
    await chain.advance(target.expiry - (await chain.chainTime()) + 1)
    const r0 = (await latestRound(chain, 0))[0]
    const k2 = chain.startKeeper()
    const t0 = Date.now()
    expect(await until(async () => (await chain.markets())[Number(target.id) - 1].status === 1, 20_000)).toBe(true)
    const settledAfter = Date.now() - t0
    expect((await latestRound(chain, 0))[0]).toBeGreaterThan(r0)
    expect((await chain.markets()).length).toBe(9) // no rotation before the scan reached the head
    expect(settledAfter).toBeLessThan(6000)
    expect(await until(async () => (await chain.markets()).length >= 12, 40_000)).toBe(true)
    expect(k2.count(/failed/)).toBe(0)
  }, 120_000)
})

describe('two keeper instances share the price pushing', () => {
  let chain: Chain
  beforeAll(async () => {
    chain = await freshChain()
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  /** Senders of feed rounds and oracle observations from block `from` on. */
  async function senders(from: bigint) {
    const rounds = (
      await Promise.all(chain.addrs.feeds.map((f) => chain.pub.getContractEvents({ address: f, abi: aggregatorAbi, eventName: 'AnswerUpdated', fromBlock: from })))
    ).flat()
    const obs = await chain.pub.getContractEvents({ address: chain.addrs.oracle, abi: oracleAbi, eventName: 'ObservationRecorded', fromBlock: from })
    const from_ = async (logs: { transactionHash: Hex }[]) =>
      new Set(await Promise.all(logs.map(async (l) => (await chain.pub.getTransaction({ hash: l.transactionHash })).from.toLowerCase())))
    return { rounds: await from_(rounds), obs: await from_(obs) }
  }

  test('only instance 0 pushes prices and pokes; instance 1 takes over once it is gone', async () => {
    const keeper = addr(KEYS.keeper).toLowerCase()
    const backup = addr(KEYS.pusher).toLowerCase()
    const b0 = (await chain.pub.getBlockNumber()) + 1n
    const k0 = chain.startKeeper({ KEEPER_INDEX: '0', KEEPER_COUNT: '2', KEEPER_PEERS: backup })
    chain.startKeeper({ KEEPER_PRIVATE_KEY: KEYS.pusher, KEEPER_INDEX: '1', KEEPER_COUNT: '2', KEEPER_PEERS: keeper })
    expect(await until(async () => (await chain.markets()).length >= 9, 30_000)).toBe(true)
    for (let i = 0; i < 8; i++) {
      await chain.advance(20)
      await Bun.sleep(1500)
    }
    const before = await senders(b0)
    expect([...before.rounds]).toEqual([keeper])
    expect([...before.obs]).toEqual([keeper])
    k0.stop()
    await Bun.sleep(500)
    const b1 = (await chain.pub.getBlockNumber()) + 1n
    for (let i = 0; i < 10; i++) {
      await chain.advance(20)
      await Bun.sleep(1500)
    }
    const after = await senders(b1)
    expect(after.rounds.has(backup)).toBe(true)
    expect(after.obs.has(backup)).toBe(true)
  }, 120_000)
})
