/* oxlint-disable typescript/no-explicit-any -- live probes read loosely typed RPC results */
/**
 * Live read-only checks against the Arc Testnet deployment (bun test tests/live).
 * Requires network access to https://rpc.testnet.arc.io. Nothing is sent on chain.
 */
import { describe, expect, test, beforeAll } from 'bun:test'
import { createPublicClient, erc20Abi, http, type Address } from 'viem'
import { arcTestnet } from 'viem/chains'
import { aggregatorAbi, marketAbi, oracleAbi } from '../../src/lib/abis'

const RPC = process.env.ARC_RPC ?? 'https://rpc.testnet.arc.io'
const MARKET = '0xad96602776250f18a4d46ab7b2f0c56a5fda2df5' as Address
const ORACLE = '0x465ec9f24ad95cdb73c72b2de1ccb0ac827723e3' as Address
const USDC = '0x3600000000000000000000000000000000000000' as Address
const KEEPER = '0x3F04776B2b253abdC3DF386d82Bc182BE674BF7f' as Address
const FEEDS = [
  '0x83eec3cbda541e441ff5f919fa47faefb20678ae',
  '0xc7e7bcd1e9a28cecb58dad6a4459b9f81db4c970',
  '0x4395f10c126fbfb0b3b229648ceeba4bd7fca004',
] as Address[]
const ASSET_KEYS = ['BTC', 'ETH', 'SOL']
const MIN_VOL = [0.3e18, 0.4e18, 0.5e18].map((v) => BigInt(v))
const DURATIONS = [300n, 900n, 3600n]
const VOID_DELAY = 86_400n

const client = createPublicClient({ chain: arcTestnet, transport: http(RPC, { retryCount: 5, timeout: 30_000 }) })

type Market = {
  assetId: number
  status: number
  upWon: boolean
  createdAt: number
  expiry: number
  strike: bigint
  settlePrice: bigint
  upUnits: bigint
  downUnits: bigint
  totalCost: bigint
}

let now = 0n
let headBlock = 0n
let markets: Market[] = []
let deployBlock = 0n

const reserve = (up: bigint, down: bigint) => {
  const max = up > down ? up : down
  const min = up > down ? down : up
  return max + (min * 99n + 99n) / 100n
}

async function findDeployBlock(): Promise<bigint> {
  let lo = 0n
  let hi = headBlock
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const code = await client.getCode({ address: MARKET, blockNumber: mid })
    if (code && code !== '0x') hi = mid
    else lo = mid + 1n
  }
  return lo
}

async function logs(eventName: 'Settled' | 'Claimed' | 'Voided' | 'Bought' | 'Sold' | 'MarketCreated' | 'Deposited' | 'Withdrawn') {
  if (deployBlock === 0n) deployBlock = await findDeployBlock()
  return scan(MARKET, marketAbi, eventName, deployBlock)
}

async function scan(address: Address, abi: any, eventName: string, fromBlock: bigint) {
  const out: any[] = []
  const CHUNK = 2_000n
  for (let from = fromBlock; from <= headBlock; from += CHUNK) {
    const to = from + CHUNK - 1n > headBlock ? headBlock : from + CHUNK - 1n
    for (let attempt = 0; ; attempt++) {
      try {
        const l = await client.getContractEvents({ address, abi, eventName, fromBlock: from, toBlock: to } as any)
        out.push(...l)
        break
      } catch (e) {
        if (attempt > 8) throw e
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
      }
    }
  }
  return out
}

beforeAll(async () => {
  const block = await client.getBlock()
  now = block.timestamp
  headBlock = block.number
  const count = (await client.readContract({ address: MARKET, abi: marketAbi, functionName: 'marketCount' })) as bigint
  for (let from = 1n; from <= count; from += 100n) {
    const take = count - from + 1n > 100n ? 100n : count - from + 1n
    const list = (await client.readContract({
      address: MARKET,
      abi: marketAbi,
      functionName: 'getMarketsRange',
      args: [from, take],
    })) as unknown as Market[]
    markets.push(...list)
  }
}, 120_000)

describe('live deployment state', () => {
  test('chain id and owners', async () => {
    expect(await client.getChainId()).toBe(5042002)
    const owners = await Promise.all(
      [MARKET, ORACLE, ...FEEDS].map((a) =>
        client.readContract({ address: a, abi: marketAbi, functionName: 'owner' }) as Promise<Address>,
      ),
    )
    for (const o of owners) expect(o.toLowerCase()).toBe(KEEPER.toLowerCase())
  })

  test('vault solvency: balance >= totalLocked + unclaimedPayouts + void buffer, and accounting matches markets', async () => {
    const [balance, assets, shareSupply, locked, pending, free, sp, wsp] = (await client.readContract({
      address: MARKET,
      abi: marketAbi,
      functionName: 'vaultStats',
    })) as readonly bigint[]
    const rawBalance = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [MARKET] })
    console.log({ balance, assets, shareSupply, locked, pending, free, sp, wsp, marketCount: markets.length })
    expect(rawBalance).toBe(balance)
    expect(balance).toBeGreaterThanOrEqual(locked + pending)
    // totalLocked must equal the sum of reserves of open markets
    let sumLocked = 0n
    let sumBuffer = 0n
    for (const m of markets) {
      if (m.status !== 0) continue
      const r = reserve(m.upUnits, m.downUnits)
      sumLocked += r
      sumBuffer += m.totalCost > r ? m.totalCost - r : 0n
    }
    expect(locked).toBe(sumLocked)
    expect(assets - free).toBe(locked + sumBuffer > assets ? assets : locked + sumBuffer)
  })

  test('feeds are fresh (keeper is pushing) and trading staleness is satisfied', async () => {
    const maxAge = (await client.readContract({ address: MARKET, abi: marketAbi, functionName: 'maxTradeStaleness' })) as bigint
    for (let i = 0; i < 3; i++) {
      const [, , updatedAt] = await client
        .readContract({ address: ORACLE, abi: oracleAbi, functionName: 'getPrice', args: [i] })
        .then((r: any) => [0, r[0], r[1]])
      const age = now - (updatedAt as bigint)
      console.log(`${ASSET_KEYS[i]} feed age ${age}s`)
      expect(age).toBeLessThanOrEqual(maxAge)
    }
  })

  test('one live market per asset and duration (keeper rotation)', () => {
    for (let a = 0; a < 3; a++) {
      for (const d of DURATIONS) {
        const open = markets.filter(
          (m) => m.assetId === a && m.status === 0 && BigInt(m.expiry) - BigInt(m.createdAt) === d && BigInt(m.expiry) > now,
        )
        expect(open.length).toBeGreaterThanOrEqual(1)
      }
    }
  })

  test('no market sits expired and unsettled for long (keeper settles within 10 minutes)', () => {
    const stuck = markets
      .map((m, i) => ({ id: i + 1, ...m }))
      .filter((m) => m.status === 0 && now > BigInt(m.expiry) + 600n)
    if (stuck.length) {
      console.log(
        'expired-unsettled markets:',
        stuck.map((m) => ({
          id: m.id,
          asset: ASSET_KEYS[m.assetId],
          expiredAgoS: Number(now - BigInt(m.expiry)),
          voidable: now >= BigInt(m.expiry) + VOID_DELAY,
          up: m.upUnits,
          down: m.downUnits,
          cost: m.totalCost,
        })),
      )
    }
    expect(stuck.length).toBe(0)
  })

  test('every settled market used the first feed round at or after expiry', async () => {
    const roundCache = new Map<string, readonly bigint[]>()
    const getRound = async (feed: Address, r: bigint) => {
      const k = `${feed}:${r}`
      if (!roundCache.has(k))
        roundCache.set(
          k,
          (await client.readContract({ address: feed, abi: aggregatorAbi, functionName: 'getRoundData', args: [r] })) as unknown as bigint[],
        )
      return roundCache.get(k)!
    }
    const firstAtOrAfter = async (feed: Address, expiry: bigint) => {
      const latest = (await client.readContract({ address: feed, abi: aggregatorAbi, functionName: 'latestRoundData' })) as unknown as bigint[]
      let lo = 1n
      let hi = latest[0]
      while (lo < hi) {
        const mid = (lo + hi) / 2n
        if ((await getRound(feed, mid))[3] >= expiry) hi = mid
        else lo = mid + 1n
      }
      return lo
    }
    const settledIds = markets.map((m, i) => ({ id: i + 1, ...m })).filter((m) => m.status === 1)
    // Sample: all markets with positions plus the 30 most recent.
    const sample = settledIds.filter((m) => m.upUnits + m.downUnits > 0n || m.id > markets.length - 30)
    const wrong: unknown[] = []
    const delays: number[] = []
    for (const m of sample) {
      const feed = FEEDS[m.assetId]
      const r = await firstAtOrAfter(feed, BigInt(m.expiry))
      const d = await getRound(feed, r)
      delays.push(Number(d[3] - BigInt(m.expiry)))
      const expected = d[1] * 10n ** 10n
      if (expected !== m.settlePrice) wrong.push({ id: m.id, expected, got: m.settlePrice, round: r })
    }
    console.log(`checked ${sample.length} settled markets; settlement round delay after expiry: max ${Math.max(...delays)}s, mean ${(delays.reduce((a, b) => a + b, 0) / delays.length).toFixed(1)}s`)
    expect(wrong).toEqual([])
  }, 600_000)

  test('realized volatility observations (informational: floors dominate)', async () => {
    const results: string[] = []
    for (let i = 0; i < 3; i++) {
      const [count, vol] = await Promise.all([
        client.readContract({ address: ORACLE, abi: oracleAbi, functionName: 'getObservationCount', args: [i] }),
        client.readContract({ address: ORACLE, abi: oracleAbi, functionName: 'getVol', args: [i] }),
      ])
      results.push(`${ASSET_KEYS[i]} obs=${count} vol=${Number(vol) / 1e18} min=${Number(MIN_VOL[i]) / 1e18}`)
    }
    console.log(results.join('\n'))
    for (let i = 0; i < 3; i++) {
      const vol = (await client.readContract({ address: ORACLE, abi: oracleAbi, functionName: 'getVol', args: [i] })) as bigint
      expect(vol).toBeGreaterThanOrEqual(MIN_VOL[i])
    }
  })

  test('feed round ids are contiguous and timestamps monotonic over the last 50 rounds', async () => {
    for (let i = 0; i < 3; i++) {
      const latest = (await client.readContract({ address: FEEDS[i], abi: aggregatorAbi, functionName: 'latestRoundData' })) as readonly [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ]
      let prevTs = 0n
      for (let r = latest[0] - 49n; r <= latest[0]; r++) {
        const d = (await client.readContract({ address: FEEDS[i], abi: aggregatorAbi, functionName: 'getRoundData', args: [r] })) as readonly [
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
        ]
        expect(d[0]).toBe(r)
        expect(d[1] > 0n).toBe(true)
        expect(d[3]).toBeGreaterThanOrEqual(prevTs)
        prevTs = d[3]
      }
    }
  }, 120_000)
})

describe('live event accounting (scans from deploy block)', () => {
  test('unclaimedPayouts equals settled-winner units + void costs minus claims', async () => {
    deployBlock = await findDeployBlock()
    console.log('deploy block', deployBlock, 'head', headBlock)
    const settled = await logs('Settled')
    const voided = await logs('Voided')
    const claimed = await logs('Claimed')
    const bought = await logs('Bought')
    const sold = await logs('Sold')
    console.log({ settled: settled.length, voided: voided.length, claimed: claimed.length, bought: bought.length, sold: sold.length })
    let liabilities = 0n
    for (const m of markets) {
      if (m.status === 1) liabilities += m.upWon ? m.upUnits : m.downUnits
      if (m.status === 2) liabilities += m.totalCost
    }
    const claimedSum = claimed.reduce((s, l) => s + (l.args.amount as bigint), 0n)
    const pending = (await client.readContract({ address: MARKET, abi: marketAbi, functionName: 'unclaimedPayouts' })) as bigint
    console.log({ liabilities, claimedSum, pending })
    expect(pending).toBe(liabilities - claimedSum)

    // Cash-flow reconciliation: every USDC that entered or left through the contract's own flows.
    const deposited = await logs('Deposited')
    const withdrawn = await logs('Withdrawn')
    const inflow =
      deposited.reduce((s, l) => s + (l.args.amount as bigint), 0n) + bought.reduce((s, l) => s + (l.args.cost as bigint), 0n)
    const outflow =
      withdrawn.reduce((s, l) => s + (l.args.amount as bigint), 0n) +
      sold.reduce((s, l) => s + (l.args.proceeds as bigint), 0n) +
      claimedSum
    const balance = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [MARKET] })
    console.log({
      deposits: deposited.map((l) => [l.args.user, l.args.amount, l.args.shares]),
      withdrawals: withdrawn.map((l) => [l.args.user, l.args.amount, l.args.shares]),
      buys: bought.map((l) => [l.args.marketId, l.args.user, l.args.isUp, l.args.units, l.args.cost]),
      sells: sold.map((l) => [l.args.marketId, l.args.user, l.args.isUp, l.args.units, l.args.proceeds]),
      inflow,
      outflow,
      balance,
      unexplained: balance - (inflow - outflow),
    })
    expect(balance).toBeGreaterThanOrEqual(inflow - outflow)

    // Every settled market's upWon must be consistent with settlePrice > strike.
    for (const m of markets) if (m.status === 1) expect(m.upWon).toBe(m.settlePrice > m.strike)
  }, 600_000)

  test('regression: unclaimed winnings outside the 60-market window are found by the per-user Bought scan the Positions table uses', async () => {
    // src/hooks/data.ts fetchMarkets() reads only the newest 60 markets (about 70 minutes at the keeper's
    // rate). usePositions now also takes the wallet's markets from Bought logs filtered by the indexed user
    // topic (scanMyMarketIds, <= 10,000-block ranges), so old claims keep their Claim button.
    const UI_WINDOW = 60
    const count = markets.length
    const windowStart = count - UI_WINDOW + 1
    const oldestInWindow = markets[windowStart - 1]
    const windowMinutes = Number(now - BigInt(oldestInWindow.createdAt)) / 60
    const lastHour = markets.filter((m) => BigInt(m.createdAt) > now - 3600n).length
    console.log(`markets created in the last hour: ${lastHour}; the recent window covers markets created in the last ${windowMinutes.toFixed(1)} min`)

    const bought = await logs('Bought')
    const users = [...new Set(bought.map((l) => (l.args.user as string).toLowerCase()))] as Address[]
    const outside: { user: Address; marketId: bigint; claimable: bigint }[] = []
    for (const u of users) {
      for (const id of [...new Set(bought.filter((l) => l.args.user.toLowerCase() === u).map((l) => l.args.marketId as bigint))]) {
        const m = markets[Number(id) - 1]
        if (m.status === 0) continue
        const [up, down, upCost, downCost] = (await client.readContract({
          address: MARKET,
          abi: marketAbi,
          functionName: 'getPosition',
          args: [id, u],
        })) as readonly bigint[]
        const claimable = m.status === 1 ? (m.upWon ? up : down) : upCost + downCost
        if (claimable > 0n && Number(id) < windowStart) outside.push({ user: u, marketId: id, claimable })
      }
    }
    console.log('claimable positions outside the recent window:', outside)
    for (const u of [...new Set(outside.map((o) => o.user))]) {
      const mine = new Set<string>()
      const CHUNK = 10_000n
      for (let from = deployBlock; from <= headBlock; from += CHUNK) {
        const to = from + CHUNK - 1n > headBlock ? headBlock : from + CHUNK - 1n
        const l = await client.getContractEvents({ address: MARKET, abi: marketAbi, eventName: 'Bought', args: { user: u }, fromBlock: from, toBlock: to })
        for (const x of l) mine.add(String(x.args.marketId))
      }
      for (const o of outside.filter((x) => x.user === u)) expect(mine.has(String(o.marketId))).toBe(true)
    }
  }, 600_000)

  test('on-chain getVol matches an off-chain recomputation from ObservationRecorded events', async () => {
    if (deployBlock === 0n) deployBlock = await findDeployBlock()
    // Observations within the last ~32 samples * 60s+; scan the last 6000 blocks generously.
    const from = headBlock > 20_000n ? headBlock - 20_000n : 0n
    const events = await scan(ORACLE, oracleAbi, 'ObservationRecorded', from)
    for (let i = 0; i < 3; i++) {
      const obs = events.filter((e) => Number(e.args.assetId) === i).slice(-32)
      if (obs.length < 32) continue
      let sumSq = 0
      let sumDt = 0
      const gaps: number[] = []
      let zeroReturns = 0
      for (let k = 1; k < obs.length; k++) {
        const r = Math.log(Number(obs[k].args.price) / Number(obs[k - 1].args.price))
        if (r === 0) zeroReturns++
        sumSq += r * r
        const dt = Number(obs[k].args.timestamp - obs[k - 1].args.timestamp)
        gaps.push(dt)
        sumDt += dt
      }
      const raw = Math.sqrt((sumSq * 31_536_000) / sumDt)
      const onchain = Number(await client.readContract({ address: ORACLE, abi: oracleAbi, functionName: 'getVol', args: [i] })) / 1e18
      const clamped = Math.max(Number(MIN_VOL[i]) / 1e18, raw)
      console.log(
        `${ASSET_KEYS[i]} raw realized=${raw.toFixed(4)} onchain=${onchain} zeroReturns=${zeroReturns}/31 meanGap=${(sumDt / 31).toFixed(1)}s maxGap=${Math.max(...gaps)}s`,
      )
      if (raw < 1.5) expect(Math.abs(onchain - clamped)).toBeLessThan(0.01)
    }
  }, 600_000)
})
