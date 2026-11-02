/**
 * scripts/lib.ts price sources and helpers without a chain: Kraken mid validation, the Data Streams HMAC
 * headers and report decoding, and revert vs transport error classification.
 * Run: bun test tests/keeper/lib.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ContractFunctionExecutionError, ContractFunctionRevertedError, HttpRequestError, encodeAbiParameters, type Hex } from 'viem'

let kraken: Record<string, unknown> = {}
let krakenStatus = 200
let streams: { status: number; body: unknown } = { status: 200, body: {} }
let streamsByPath: Record<string, { status: number; body: unknown }> = {} // overrides `streams` per path
const streamsPaths: string[] = []
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/0/public/Ticker') return Response.json(kraken, { status: krakenStatus })
    streamsPaths.push(url.pathname + url.search)
    const r = streamsByPath[url.pathname] ?? streams
    return Response.json(r.body, { status: r.status })
  },
})
process.env.VITE_MARKET_ADDRESS = '0x0000000000000000000000000000000000000001'
process.env.VITE_ORACLE_ADDRESS = '0x0000000000000000000000000000000000000002'
process.env.KEEPER_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
process.env.NETWORK = 'mainnet'
process.env.KRAKEN_API_URL = `http://127.0.0.1:${server.port}`
process.env.STREAMS_API_URL = `http://127.0.0.1:${server.port}`
process.env.STREAMS_API_KEY = 'k'
process.env.STREAMS_API_SECRET = 'very-secret'
let lib: typeof import('../../scripts/lib')
beforeAll(async () => {
  lib = await import('../../scripts/lib')
})
afterAll(() => server.stop(true))

const BTC: Hex = '0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8'
const NVDA: Hex = '0x0002d9b165cfb7309e8a13af14cbbb608d9990f9fa094d2ac6199d2567f2dae8'
const NVDA_EQ: Hex = '0x0008adc184847ba8d17f0030c15e78f61b83eda2e190f30346c4ea3babed647d'
const head = [{ type: 'bytes32' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'uint192' }, { type: 'uint192' }, { type: 'uint32' }] as const
const zero = `0x${'00'.repeat(32)}` as Hex
const wrap = (data: Hex) =>
  encodeAbiParameters([{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }], [[zero, zero, zero], data, [], [], zero])
const v3 = (id: Hex, obs: number, price: bigint) =>
  wrap(encodeAbiParameters([...head, { type: 'int192' }, { type: 'int192' }, { type: 'int192' }], [id, obs, obs, 0n, 0n, obs + 60, price, price - 1n, price + 1n]))
const v2 = (id: Hex, obs: number, price: bigint) => wrap(encodeAbiParameters([...head, { type: 'int192' }], [id, obs, obs, 0n, 0n, obs + 60, price]))
const v8 = (id: Hex, obs: number, price: bigint, status: number) =>
  wrap(encodeAbiParameters([...head, { type: 'uint64' }, { type: 'int192' }, { type: 'uint32' }], [id, obs, obs, 0n, 0n, obs + 60, BigInt(obs), price, status]))

describe('krakenMid8', () => {
  const ticker = (bid: string, ask: string) => ({ error: [], result: { NVDAxUSD: { a: [ask, '3', '3.000'], b: [bid, '3', '3.000'], c: ['1', '1'] } } })
  test('mid of the best bid and ask, exact at 8 decimals', async () => {
    kraken = ticker('204.41', '204.42')
    krakenStatus = 200
    expect(await lib.krakenMid8('NVDAxUSD')).toBe(20_441_500_000n)
  })
  test.each([
    ['crossed book', ticker('204.43', '204.42'), /crossed/],
    ['spread over 2%', ticker('200', '205'), /spread too wide/],
    ['zero bid', ticker('0', '204.42'), /non-positive/],
    ['non-numeric ask', ticker('204.41', 'NaN'), /invalid price/],
    ['negative bid', ticker('-1', '204.42'), /invalid price/],
    ['pair missing', { error: [], result: { AAPLxUSD: {} } }, /invalid price/],
    ['Kraken error', { error: ['EQuery:Unknown asset pair'], result: {} }, /Unknown asset pair/],
  ])('rejects %s', async (_name, body, re) => {
    kraken = body as Record<string, unknown>
    krakenStatus = 200
    await expect(lib.krakenMid8('NVDAxUSD')).rejects.toThrow(re)
  })
  test('rejects an HTTP error', async () => {
    krakenStatus = 503
    await expect(lib.krakenMid8('NVDAxUSD')).rejects.toThrow(/503/)
    krakenStatus = 200
  })
})

describe('Data Streams', () => {
  test('HMAC headers sign "METHOD PATH?QUERY SHA256(body) KEY TIMESTAMP" (Chainlink docs format)', () => {
    const h = lib.streamsAuthHeaders('GET', `/api/v1/reports/latest?feedID=${BTC}`, 'k', 'very-secret', 1_700_000_000_000)
    const emptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    const expected = new Bun.CryptoHasher('sha256', 'very-secret').update(`GET /api/v1/reports/latest?feedID=${BTC} ${emptySha} k 1700000000000`).digest('hex')
    expect(h).toEqual({ Authorization: 'k', 'X-Authorization-Timestamp': '1700000000000', 'X-Authorization-Signature-SHA256': expected })
  })

  test('decodes v3, v2 and v8 reports', () => {
    expect(lib.decodeReport(v3(BTC, 1000, 67_000n * 10n ** 18n))).toEqual({ feedId: BTC, observedAt: 1000n, price: 67_000n * 10n ** 18n, marketOpen: true })
    expect(lib.decodeReport(v2(NVDA, 1001, 204n * 10n ** 18n))).toEqual({ feedId: NVDA, observedAt: 1001n, price: 204n * 10n ** 18n, marketOpen: true })
    expect(lib.decodeReport(v8(NVDA_EQ, 1002, 205n * 10n ** 18n, 2)).marketOpen).toBe(true)
    expect(lib.decodeReport(v8(NVDA_EQ, 1002, 205n * 10n ** 18n, 1))).toEqual({ feedId: NVDA_EQ, observedAt: 1002n, price: 205n * 10n ** 18n, marketOpen: false })
    expect(() => lib.decodeReport(v2(`0x0004${BTC.slice(6)}`, 1, 1n))).toThrow(/schema 4/)
  })

  test('streamsReport returns the full report and checks feed, price and market status', async () => {
    const full = v3(BTC, 1000, 67_000n * 10n ** 18n)
    streams = { status: 200, body: { report: { feedID: BTC, fullReport: full } } }
    expect(await lib.streamsReport(BTC)).toEqual({ fullReport: full, observedAt: 1000n, price: 67_000n * 10n ** 18n })
    streams = { status: 200, body: { report: { fullReport: v3(BTC, 1000, 67_000n * 10n ** 18n) } } }
    await expect(lib.streamsReport(NVDA)).rejects.toThrow(/is for 0x00039d/)
    streams = { status: 200, body: { report: { fullReport: v3(BTC, 1000, 0n) } } }
    await expect(lib.streamsReport(BTC)).rejects.toThrow(/non-positive/)
    streams = { status: 200, body: { report: { fullReport: 'nothex' } } }
    await expect(lib.streamsReport(BTC)).rejects.toThrow(/no fullReport/)
    streams = { status: 200, body: { report: { fullReport: v8(NVDA_EQ, 1000, 205n * 10n ** 18n, 1) } } }
    expect(await lib.streamsReport(NVDA_EQ)).toBeUndefined()
    streams = { status: 401, body: { error: 'unauthorized' } }
    const err = await lib.streamsReport(BTC).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/401/)
    expect((err as Error).message).not.toContain('very-secret')
  })

  test('streamsSettlementReport takes the report at expiry, else the earliest in the window; only a 404 means none', async () => {
    const P = 67_000n * 10n ** 18n
    const at = (obs: number) => ({ fullReport: v3(BTC, obs, P + BigInt(obs)) })
    streamsPaths.length = 0
    streamsByPath = { '/api/v1/reports': { status: 200, body: { report: at(1000) } }, '/api/v1/reports/page': { status: 500, body: {} } }
    expect(await lib.streamsSettlementReport(BTC, 1000n, 10n)).toEqual({ fullReport: at(1000).fullReport, observedAt: 1000n, price: P + 1000n })
    expect(streamsPaths).toEqual([`/api/v1/reports?feedID=${BTC}&timestamp=1000`]) // the page is not asked
    // no report at expiry: the earliest in-window report of the page, whatever its order
    const page = { status: 200, body: { reports: [at(1012), at(1004), at(999), at(1002)] } }
    streamsByPath = { '/api/v1/reports': { status: 404, body: {} }, '/api/v1/reports/page': page }
    expect((await lib.streamsSettlementReport(BTC, 1000n, 10n))?.observedAt).toBe(1002n)
    expect(streamsPaths.at(-1)).toBe(`/api/v1/reports/page?feedID=${BTC}&startTimestamp=1000`)
    streamsByPath = { '/api/v1/reports': { status: 200, body: { report: at(1011) } }, '/api/v1/reports/page': page }
    expect((await lib.streamsSettlementReport(BTC, 1000n, 10n))?.observedAt).toBe(1002n)
    streamsByPath = { '/api/v1/reports': { status: 404, body: {} }, '/api/v1/reports/page': { status: 404, body: {} } }
    expect(await lib.streamsSettlementReport(BTC, 1000n, 10n)).toBeUndefined()
    // a closed v8 market has no settlement price
    streamsByPath = { '/api/v1/reports': { status: 200, body: { report: { fullReport: v8(NVDA_EQ, 1000, P, 1) } } } }
    expect(await lib.streamsSettlementReport(NVDA_EQ, 1000n, 10n)).toBeUndefined()
    // regression: a failed lookup at expiry (status undocumented for a second without a report) falls back to the page
    streamsByPath = { '/api/v1/reports': { status: 400, body: {} }, '/api/v1/reports/page': page }
    expect((await lib.streamsSettlementReport(BTC, 1000n, 10n))?.observedAt).toBe(1002n)
    // a same-second tie on the page goes to the smaller reportHash (StreamsFeed's rule), whatever the order
    const tie = [{ fullReport: v3(BTC, 1002, P) }, { fullReport: v3(BTC, 1002, P + 1n) }]
    const canonical = tie.map((r) => r.fullReport).sort((a, b) => (BigInt(lib.reportHash(a)) < BigInt(lib.reportHash(b)) ? -1 : 1))[0]
    for (const reports of [tie, [...tie].reverse()]) {
      streamsByPath = { '/api/v1/reports': { status: 404, body: {} }, '/api/v1/reports/page': { status: 200, body: { reports } } }
      expect((await lib.streamsSettlementReport(BTC, 1000n, 10n))?.fullReport).toBe(canonical)
    }
    // a failed request is an error, never "no report"
    streamsByPath = { '/api/v1/reports': { status: 429, body: {} }, '/api/v1/reports/page': { status: 429, body: {} } }
    await expect(lib.streamsSettlementReport(BTC, 1000n, 10n)).rejects.toThrow(/429/)
    streamsByPath = { '/api/v1/reports': { status: 404, body: {} }, '/api/v1/reports/page': { status: 503, body: {} } }
    await expect(lib.streamsSettlementReport(BTC, 1000n, 10n)).rejects.toThrow(/503/)
    streamsByPath = {}
  })
})

describe('isRevert', () => {
  const exec = (cause: Error) => new ContractFunctionExecutionError(cause as never, { abi: [], functionName: 'getRoundData' })
  test('contract reverts count, transport failures do not', () => {
    expect(lib.isRevert(exec(new ContractFunctionRevertedError({ abi: [], functionName: 'getRoundData', data: '0x08c379a0' })))).toBe(true)
    expect(lib.isRevert(exec(new ContractFunctionRevertedError({ abi: [], functionName: 'getRoundData', message: 'execution reverted' })))).toBe(true)
    // viem maps every JSON-RPC -32603 to ContractFunctionRevertedError; an upstream failure must not count
    expect(lib.isRevert(exec(new ContractFunctionRevertedError({ abi: [], functionName: 'getRoundData', message: 'upstream request timeout' })))).toBe(false)
    expect(lib.isRevert(exec(new HttpRequestError({ url: 'http://rpc', status: 429 })))).toBe(false)
    expect(lib.isRevert(new Error('fetch failed'))).toBe(false)
  })
})

describe('ageRuleDue', () => {
  // The keeper's push rule for a flat price: the 45s heartbeat, plus the age rule once the market is open (every-change
  // pushes only add rounds, which only lower the age). The keeper measures age from its tick time, the contract from
  // the block the push lands in, `latency` later. The market opens at t = 0 after two minutes of heartbeat-only pushes.
  test('regression: a 5m market never has a second where the unpushed oracle age breaks age * 4 <= time left', () => {
    const expiry = 300n
    for (const [tick, latency] of [[5n, 0n], [5n, 3n], [8n, 7n], [10n, 5n]]) {
      // every phase of the heartbeat and of the ticks against the market's creation
      for (let start = -120n; start < -60n; start++) {
        for (let phase = 0n; phase < tick; phase++) {
          let keeperAt = start // tick time of the last push, what the keeper's age counts from
          let landed = start // block time of the latest round onchain
          let landing: bigint | undefined
          for (let t = start; t < expiry; t++) {
            if (landing !== undefined && t >= landing) [landed, landing] = [landing, undefined]
            const due = t - keeperAt >= 45n || (t >= 0n && lib.ageRuleDue(t - keeperAt, expiry - t))
            if ((t + phase) % tick === 0n && due) [keeperAt, landing] = [t, t + latency]
            const timeLeft = expiry - t
            // below 4 ticks of time left one tick of age already breaks the ratio, whatever the keeper does
            if (t >= 0n && timeLeft > lib.ORACLE_AGE_RATIO * (tick + latency) && (t - landed) * lib.ORACLE_AGE_RATIO > timeLeft) {
              throw new Error(`tick ${tick}s, latency ${latency}s, start ${start}s, phase ${phase}s: age ${t - landed}s with ${timeLeft}s left`)
            }
          }
        }
      }
    }
  })
  test('no push for the age rule while the heartbeat alone keeps the ratio', () => {
    expect(lib.ageRuleDue(44n, 255n)).toBe(false)
    expect(lib.ageRuleDue(45n, 255n)).toBe(true)
    expect(lib.ageRuleDue(1000n, 0n)).toBe(false) // expired
    expect(lib.ageRuleDue(4n, 30n)).toBe(false) // pushed this tick, block time has not moved
    expect(lib.ageRuleDue(5n, 30n)).toBe(true)
  })
})

describe('keeperSlot', () => {
  test('defaults to one instance and accepts a valid slot', () => {
    expect(lib.keeperSlot()).toEqual({ count: 1, index: 0 })
    expect(lib.keeperSlot('3', '2')).toEqual({ count: 3, index: 2 })
  })
  test.each([['0', '0'], ['2', '2'], ['2', '-1'], ['1.5', '0'], ['2', '0.5'], ['abc', '0'], ['2', 'x']])('rejects KEEPER_COUNT=%s KEEPER_INDEX=%s', (count, index) => {
    expect(() => lib.keeperSlot(count, index)).toThrow(/KEEPER_COUNT must be an integer/)
  })
})
