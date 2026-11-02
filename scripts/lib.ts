/**
 * Shared helpers for the keeper and setup scripts (run with bun, never in the browser).
 * Reads VITE_* contract addresses and KEEPER_PRIVATE_KEY from .env (bun loads it automatically).
 * NETWORK=testnet (default) | mainnet picks the Arc chain; RPC_URL overrides the RPC endpoint.
 */
import { createHash, createHmac } from 'node:crypto'
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  http,
  keccak256,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arc, arcTestnet } from 'viem/chains'
import { getChain, getUsdc } from '../src/onchain-facts'

/**
 * Price sources: crypto from Coinbase, stocks from Kraken xStocks (testnet mock feeds only). On mainnet
 * the feeds are StreamsFeed contracts fed with signed Chainlink Data Streams reports for `stream`.
 */
export const ASSETS = [
  { id: 0, key: 'BTC', coinbase: 'BTC-USD', feedEnv: 'VITE_FEED_BTC', stream: '0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8' },
  { id: 1, key: 'ETH', coinbase: 'ETH-USD', feedEnv: 'VITE_FEED_ETH', stream: '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9' },
  { id: 2, key: 'SOL', coinbase: 'SOL-USD', feedEnv: 'VITE_FEED_SOL', stream: '0x0003b778d3f6b2ac4991302b89cb313f99a42467d6c9c5f96f57c29c0d2bc24f' },
  { id: 3, key: 'NVDA', kraken: 'NVDAxUSD', feedEnv: 'VITE_FEED_NVDA', stream: '0x0002d9b165cfb7309e8a13af14cbbb608d9990f9fa094d2ac6199d2567f2dae8' },
  { id: 4, key: 'AAPL', kraken: 'AAPLxUSD', feedEnv: 'VITE_FEED_AAPL', stream: '0x000231a949aa4e6a24b2c2005b16e27d03ed90e08888a2da3a68ebc9c50763df' },
] as const
export type Asset = (typeof ASSETS)[number]

export const DURATIONS = [300, 900, 3600] as const

/** PredictionMarket.ORACLE_AGE_RATIO: trades revert once the oracle age * 4 exceeds the time left. */
export const ORACLE_AGE_RATIO = 4n
/** Worst case from one keeper tick to the next one's push landing: the 5s sleep, the tick's other sends and the receipt. */
export const PUSH_LAG_S = 15n
// A trading report must still be within the feed's maxReportAge when its submit lands this long after the check.
const INCLUSION_S = 2n

/**
 * True when a feed `age` seconds old must be refreshed now for a market `timeLeft` seconds from expiry: if the
 * keeper waited, the age would break the ratio before the next tick's push lands, PUSH_LAG_S later. A round under
 * one tick (5s) old is left alone: ticks are 5s apart, so that only happens while block time stands still.
 */
export const ageRuleDue = (age: bigint, timeLeft: bigint) =>
  age >= 5n && timeLeft > 0n && (age + PUSH_LAG_S) * ORACLE_AGE_RATIO >= timeLeft - PUSH_LAG_S

/** KEEPER_COUNT and KEEPER_INDEX, checked: an integer count >= 1 and an integer index in [0, count). */
export function keeperSlot(count = '1', index = '0') {
  const c = Number(count)
  const i = Number(index)
  if (!Number.isInteger(c) || c < 1 || !Number.isInteger(i) || i < 0 || i >= c) {
    throw new Error(`KEEPER_COUNT must be an integer >= 1 and KEEPER_INDEX an integer from 0 to KEEPER_COUNT - 1, got ${count} and ${index}`)
  }
  return { count: c, index: i }
}

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing ${name} in .env`)
  return v
}

const network = process.env.NETWORK?.trim() || 'testnet'
if (network !== 'testnet' && network !== 'mainnet') throw new Error(`NETWORK must be 'testnet' or 'mainnet', got '${network}'`)
export const NETWORK: 'testnet' | 'mainnet' = network
export const chain = NETWORK === 'mainnet' ? arc : arcTestnet

export function resolveRpcUrl(): string {
  if (process.env.RPC_URL) return process.env.RPC_URL
  const chains = (process.env.RPC_PROXY_CHAINS || '').split(',')
  if (NETWORK === 'testnet' && process.env.RPC_PROXY_BASE_URL && chains.indexOf('Arc_Testnet') !== -1) {
    return `${process.env.RPC_PROXY_BASE_URL}/api/rpc/Arc_Testnet?_rpc_token=${process.env.RPC_PROXY_TOKEN}`
  }
  const urls = getChain(chain.id)?.rpcUrls
  if (!urls || urls.length === 0) throw new Error(`No RPC URL known for ${chain.name}`)
  return urls[0]
}

const usdc = getUsdc(chain.id)
if (!usdc) throw new Error(`USDC missing from onchain facts for ${chain.name}`)
export const USDC = { address: usdc.address as Address, decimals: usdc.decimals }

/** Assets with a VITE_FEED_* address; the others are not offered. */
export const enabledAssets = ASSETS.filter((a) => process.env[a.feedEnv])

export const addresses = {
  market: need('VITE_MARKET_ADDRESS') as Address,
  oracle: need('VITE_ORACLE_ADDRESS') as Address,
  /** Indexed by asset id; undefined when the asset's feed env var is unset. */
  feeds: ASSETS.map((a) => process.env[a.feedEnv] as Address | undefined),
}

export const account = privateKeyToAccount(need('KEEPER_PRIVATE_KEY') as Hex)

const transport = http(resolveRpcUrl())
export const publicClient = createPublicClient({ chain, transport })
export const walletClient = createWalletClient({ account, chain, transport })

/** True when the call reached the contract and it reverted; transport failures (429, 5xx, timeouts) are not reverts. */
export function isRevert(e: unknown): boolean {
  const r = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : undefined
  if (!(r instanceof ContractFunctionRevertedError)) return false
  // viem also maps every JSON-RPC -32603 to a revert; only trust it with revert data or a revert message
  return (r.raw !== undefined && r.raw !== '0x') || /revert/i.test(r.reason ?? '')
}

const FETCH_TIMEOUT_MS = 10_000
const MAX_SPREAD_BPS = 200n

/** A decimal price string scaled exactly to 8 decimals (Chainlink USD feed convention), rounded half up. */
function parse8(raw: unknown, what: string): bigint {
  const m = typeof raw === 'string' ? /^(\d+)(?:\.(\d*))?$/.exec(raw) : null
  if (!m) throw new Error(`${what} returned an invalid price: ${JSON.stringify(raw)}`)
  const frac = (m[2] ?? '').padEnd(9, '0')
  const price = BigInt(m[1]) * 100_000_000n + BigInt(frac.slice(0, 8)) + (frac[8] >= '5' ? 1n : 0n)
  if (price <= 0n) throw new Error(`${what} returned a non-positive price: ${m[0]}`)
  return price
}

/** Latest spot from Coinbase's public ticker, scaled to 8 decimals. */
export async function coinbaseSpot8(product: string): Promise<bigint> {
  const base = process.env.COINBASE_API_URL || 'https://api.exchange.coinbase.com'
  const res = await fetch(`${base}/products/${product}/ticker`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Coinbase ${product} ticker failed: ${res.status}`)
  const body = (await res.json()) as { price?: unknown }
  // Parse the decimal string exactly; a missing, malformed or zero price must never reach a feed.
  return parse8(body.price, `Coinbase ${product} ticker`)
}

/** Mid of the best bid and ask of a Kraken xStocks pair (e.g. NVDAxUSD), scaled to 8 decimals. */
export async function krakenMid8(pair: string): Promise<bigint> {
  const base = process.env.KRAKEN_API_URL || 'https://api.kraken.com'
  const res = await fetch(`${base}/0/public/Ticker?pair=${pair}&asset_class=tokenized_asset`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Kraken ${pair} ticker failed: ${res.status}`)
  const body = (await res.json()) as { error?: unknown; result?: Record<string, { a?: unknown[]; b?: unknown[] }> }
  if (Array.isArray(body.error) && body.error.length > 0) throw new Error(`Kraken ${pair} ticker failed: ${body.error.join(', ')}`)
  const t = body.result?.[pair]
  const ask = parse8(t?.a?.[0], `Kraken ${pair} ask`)
  const bid = parse8(t?.b?.[0], `Kraken ${pair} bid`)
  if (bid > ask) throw new Error(`Kraken ${pair} ticker is crossed: bid ${bid} > ask ${ask}`)
  const mid = (bid + ask + 1n) / 2n
  if (((ask - bid) * 10_000n) / mid > MAX_SPREAD_BPS) throw new Error(`Kraken ${pair} spread too wide: bid ${bid}, ask ${ask}`)
  return mid
}

/** Testnet source price for an asset, 8 decimals. */
export function spot8(asset: Asset): Promise<bigint> {
  return 'kraken' in asset ? krakenMid8(asset.kraken) : coinbaseSpot8(asset.coinbase)
}

/** Stream id for an asset: STREAMS_FEED_ID_<KEY>, else the Chainlink default. */
export const streamId = (asset: Asset) => (process.env[`STREAMS_FEED_ID_${asset.key}`] || asset.stream) as Hex

export interface StreamsReport {
  fullReport: Hex
  observedAt: bigint
  price: bigint
}

/** Chainlink Data Streams HMAC headers: HMAC-SHA256(secret, "METHOD PATH?QUERY SHA256HEX(body) KEY TIMESTAMP_MS"). */
export function streamsAuthHeaders(method: string, pathWithQuery: string, key: string, secret: string, timestamp = Date.now()) {
  const bodyHash = createHash('sha256').update('').digest('hex')
  const signature = createHmac('sha256', secret).update(`${method} ${pathWithQuery} ${bodyHash} ${key} ${timestamp}`).digest('hex')
  return { Authorization: key, 'X-Authorization-Timestamp': String(timestamp), 'X-Authorization-Signature-SHA256': signature }
}

const fullReportParams = [{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }] as const
const head = [{ type: 'bytes32' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'uint192' }, { type: 'uint192' }, { type: 'uint32' }] as const

/**
 * Reads feed id, observation time and price from a full report (the layout StreamsFeed.submit verifies).
 * Only used to decide whether to submit; the VerifierProxy checks the signatures onchain.
 * Schemas: v2 price, v3 price/bid/ask, v8 midPrice + marketStatus (2 = open).
 */
export function decodeReport(fullReport: Hex): { feedId: Hex; observedAt: bigint; price: bigint; marketOpen: boolean } {
  const [, data] = decodeAbiParameters(fullReportParams, fullReport)
  const schema = Number.parseInt(data.slice(2, 6), 16)
  if (schema === 2 || schema === 3) {
    const [feedId, , observedAt, , , , price] = decodeAbiParameters([...head, { type: 'int192' }], data)
    return { feedId, observedAt: BigInt(observedAt), price, marketOpen: true }
  }
  if (schema === 8) {
    const [feedId, , observedAt, , , , , price, status] = decodeAbiParameters([...head, { type: 'uint64' }, { type: 'int192' }, { type: 'uint32' }], data)
    return { feedId, observedAt: BigInt(observedAt), price, marketOpen: status === 2 }
  }
  throw new Error(`unsupported report schema ${schema}`)
}

/** keccak256 of the report data in a full report: StreamsFeed gives a same-second settlement tie to the smaller one. */
export const reportHash = (fullReport: Hex) => keccak256(decodeAbiParameters(fullReportParams, fullReport)[1])

/**
 * How old a report observed at `observedAt` will be when a submit sent now lands (StreamsFeed.submit checks maxReportAge).
 * Inclusion time is the later of chain and host time (an idle chain's latest block lags the clock) plus INCLUSION_S.
 */
export async function ageOnInclusion(observedAt: bigint) {
  const block = (await publicClient.getBlock()).timestamp
  const clock = BigInt(Math.floor(Date.now() / 1000))
  return (block > clock ? block : clock) + INCLUSION_S - observedAt
}

const streamsBase = () =>
  (process.env.STREAMS_API_URL || (NETWORK === 'mainnet' ? 'https://api.dataengine.chain.link' : 'https://api.testnet-dataengine.chain.link')).replace(/\/$/, '')

/** GET a Data Streams REST path with the HMAC headers; null on 404, throws on any other non-2xx or transport error. */
async function streamsGet(pathWithQuery: string, feedId: Hex): Promise<Record<string, unknown> | null> {
  const url = new URL(`${streamsBase()}${pathWithQuery}`)
  const headers = streamsAuthHeaders('GET', url.pathname + url.search, need('STREAMS_API_KEY'), need('STREAMS_API_SECRET'))
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Data Streams report ${feedId.slice(0, 10)} failed: ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

/** A REST report object checked against `feedId`; `marketOpen` false for a closed v8 market. */
function parseReport(report: unknown, feedId: Hex): StreamsReport & { marketOpen: boolean } {
  const full = (report as { fullReport?: unknown } | undefined)?.fullReport
  if (typeof full !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(full)) throw new Error(`Data Streams report ${feedId.slice(0, 10)} has no fullReport`)
  const r = decodeReport(full as Hex)
  if (r.feedId.toLowerCase() !== feedId.toLowerCase()) throw new Error(`Data Streams report is for ${r.feedId}, not ${feedId}`)
  if (r.price <= 0n) throw new Error(`Data Streams report ${feedId.slice(0, 10)} has a non-positive price`)
  return { fullReport: full as Hex, observedAt: r.observedAt, price: r.price, marketOpen: r.marketOpen }
}

/**
 * The latest signed report for a stream from the Data Streams REST API
 * (GET /api/v1/reports/latest?feedID=..., STREAMS_API_KEY / STREAMS_API_SECRET). Undefined while a v8 market is closed.
 */
export async function streamsReport(feedId: Hex): Promise<StreamsReport | undefined> {
  const body = await streamsGet(`/api/v1/reports/latest?feedID=${feedId}`, feedId)
  if (!body) throw new Error(`Data Streams report ${feedId.slice(0, 10)} failed: 404`)
  const { marketOpen, ...r } = parseReport(body.report, feedId)
  return marketOpen ? r : undefined
}

/**
 * The settlement report for `expiry`: the earliest report observed in [expiry, expiry + window] (StreamsFeed.submitSettlement).
 * Asks for the report at `expiry` (GET /api/v1/reports?feedID=..&timestamp=<seconds>); when there is none in the window (or
 * that request fails: the status for a second without a report is undocumented), takes the earliest in-window one from
 * GET /api/v1/reports/page?feedID=..&startTimestamp=<expiry>, a same-second tie going to the smaller reportHash. Undefined
 * when no report is in the window or a v8 market was closed; page errors other than 404 throw, so a failed request is never
 * read as "no report".
 */
export async function streamsSettlementReport(feedId: Hex, expiry: bigint, window: bigint): Promise<StreamsReport | undefined> {
  const inWindow = (r: StreamsReport) => r.observedAt >= expiry && r.observedAt <= expiry + window
  const exact = await streamsGet(`/api/v1/reports?feedID=${feedId}&timestamp=${expiry}`, feedId).catch(() => null)
  let best = exact ? parseReport(exact.report, feedId) : undefined
  if (!best || !inWindow(best)) {
    const page = await streamsGet(`/api/v1/reports/page?feedID=${feedId}&startTimestamp=${expiry}`, feedId)
    const list = Array.isArray(page?.reports) ? page.reports.map((x) => parseReport(x, feedId)).filter(inWindow) : []
    const first = (a: StreamsReport, r: StreamsReport) =>
      a.observedAt < r.observedAt || (a.observedAt === r.observedAt && BigInt(reportHash(a.fullReport)) <= BigInt(reportHash(r.fullReport)))
    best = list.reduce<typeof best>((a, r) => (a && first(a, r) ? a : r), undefined)
  }
  return best?.marketOpen ? { fullReport: best.fullReport, observedAt: best.observedAt, price: best.price } : undefined
}

export async function send(hash: Hex): Promise<TransactionReceipt> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`)
  return receipt
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
