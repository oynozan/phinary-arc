/**
 * Live data layer. Every query reads once over the WebSocket client and is then kept fresh by
 * pushed events (see useRealtimeSync). Nothing polls, and data is never cleared while a refresh
 * is in flight, so the UI does not flash back to a loading state.
 */
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { erc20Abi, type Address } from 'viem'
import { rpc } from '@/lib/realtime'
import { DEPLOY_BLOCK, KEEPER_ADDRESSES, MARKET_ADDRESS, ORACLE_ADDRESS, USDC_ADDRESS, type Market } from '@/lib/contracts'
import { marketAbi, oracleAbi } from '@/lib/abis'
import { DEFAULT_MAX_STRIKE_DEVIATION } from '@/lib/strike'

const LIVE = {
  staleTime: Infinity,
  gcTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  placeholderData: keepPreviousData,
  retry: 6,
  retryDelay: (attempt: number) => Math.min(400 * 2 ** attempt, 5000),
} as const

const market = { address: MARKET_ADDRESS, abi: marketAbi } as const
const oracle = { address: ORACLE_ADDRESS, abi: oracleAbi } as const

export const qk = {
  markets: ['markets'] as const,
  oracle: (assetId: number) => ['oracle', assetId] as const,
  oracleSeries: (assetId: number) => ['oracleSeries', assetId] as const,
  sigma: (assetId: number) => ['sigma', assetId] as const,
  params: ['params'] as const,
  strikeDeviation: ['strikeDeviation'] as const,
  position: (id: bigint, who: string) => ['position', String(id), who] as const,
  positions: (who: string) => ['positions', who] as const,
  myMarkets: (who: string) => ['myMarkets', who] as const,
  marketsById: (ids: string) => ['marketsById', ids] as const,
  usdc: (who: string) => ['usdc', who] as const,
  vault: (who: string) => ['vault', who] as const,
  preview: (shares: bigint) => ['previewWithdraw', String(shares)] as const,
  bets: (id: bigint) => ['bets', String(id)] as const,
  history: (who: string) => ['history', who] as const,
}

export interface OracleSpot {
  price: bigint
  updatedAt: number
}

export interface Order {
  stopPrice: bigint
  takeProfitPrice: bigint
}

export interface MyPosition {
  upUnits: bigint
  downUnits: bigint
  upCost: bigint
  downCost: bigint
  upOrder: Order
  downOrder: Order
}

export const EMPTY_POSITION: MyPosition = {
  upUnits: 0n,
  downUnits: 0n,
  upCost: 0n,
  downCost: 0n,
  upOrder: { stopPrice: 0n, takeProfitPrice: 0n },
  downOrder: { stopPrice: 0n, takeProfitPrice: 0n },
}

type RawMarket = Omit<Market, 'id' | 'createdAt' | 'expiry' | 'byKeeper'> & { createdAt: number | bigint; expiry: number | bigint }

function toMarket(id: bigint, m: RawMarket): Market {
  return {
    id,
    assetId: m.assetId,
    status: m.status,
    upWon: m.upWon,
    createdAt: Number(m.createdAt),
    expiry: Number(m.expiry),
    strike: m.strike,
    settlePrice: m.settlePrice,
    upUnits: m.upUnits,
    downUnits: m.downUnits,
    totalCost: m.totalCost,
    byKeeper: keeperMarkets.has(String(id)),
  }
}

/** Arc's RPC rejects getLogs ranges over 10,000 blocks. */
export const LOG_CHUNK = 10_000n

/**
 * Ids of markets a keeper opened (the rolling ones), from MarketCreated logs filtered by the indexed
 * creator (any address in VITE_KEEPER_ADDRESS). createMarket is permissionless, so this keeps a user's
 * custom-strike market from replacing the rolling market for everyone. The first call covers the last 10,000 blocks, more than the hour a 1h market
 * stays open at Arc's ~0.5s blocks; later calls only scan new blocks.
 */
const keeperMarkets = new Set<string>()
let keeperScannedTo = 0n

async function scanKeeperMarkets(): Promise<void> {
  if (KEEPER_ADDRESSES.length === 0) return
  try {
    const head = await rpc.getBlockNumber()
    let from = keeperScannedTo + 1n
    if (head >= LOG_CHUNK && from < head - LOG_CHUNK + 1n) from = head - LOG_CHUNK + 1n
    if (from < DEPLOY_BLOCK) from = DEPLOY_BLOCK
    if (from > head) return
    const logs = await rpc.getContractEvents({ address: MARKET_ADDRESS, abi: marketAbi, eventName: 'MarketCreated', args: { creator: KEEPER_ADDRESSES }, fromBlock: from, toBlock: head })
    for (const l of logs) if (l.args.marketId !== undefined) keeperMarkets.add(String(l.args.marketId))
    if (head > keeperScannedTo) keeperScannedTo = head
  } catch {
    /* markets still load; the next refresh scans again */
  }
}

export const DURATIONS = [300, 900, 3600] as const
const MARKET_PAGE = 60n

/**
 * The newest markets, paged back until a page starts with a market created over the longest duration ago.
 * Ids follow creation time, so every market that can still be open is in the list, however many the keeper
 * (5 assets x 17 rolling markets an hour) and users opened since.
 */
export async function fetchMarkets(): Promise<Market[]> {
  const [count] = await Promise.all([rpc.readContract({ ...market, functionName: 'marketCount' }), scanKeeperMarkets()])
  // 300s slack: a fast browser clock against on-chain createdAt must not stop paging early.
  const before = Math.floor(Date.now() / 1000) - Math.max(...DURATIONS) - 300
  const out: Market[] = []
  for (let to = count; to > 0n; ) {
    const from = to > MARKET_PAGE ? to - MARKET_PAGE + 1n : 1n
    const list = await rpc.readContract({ ...market, functionName: 'getMarketsRange', args: [from, to - from + 1n] })
    out.unshift(...list.map((m, i) => toMarket(from + BigInt(i), m)))
    if (out[0].createdAt <= before) break
    to = from - 1n
  }
  return out
}

/** Markets by id, whatever their age (the recent list only reaches back to markets that can still be open). */
export async function fetchMarketsById(ids: bigint[]): Promise<Market[]> {
  const out: Market[] = []
  for (let a = 0; a < ids.length; a += 60) {
    const chunk = ids.slice(a, a + 60)
    const res = await rpc.multicall({ contracts: chunk.map((id) => ({ ...market, functionName: 'getMarket', args: [id] }) as const), allowFailure: false })
    res.forEach((m, i) => out.push(toMarket(chunk[i], m)))
  }
  return out
}

interface MyMarketIds {
  ids: bigint[]
  scannedTo: bigint
}

/**
 * Every market the wallet bought into, from its own Bought logs (filtered by the indexed user topic), so a
 * win or refund stays claimable in the UI however old the market is. Scanned once from the deploy block,
 * then only new blocks.
 */
export async function scanMyMarketIds(who: Address, prev: MyMarketIds | undefined): Promise<MyMarketIds> {
  const head = await rpc.getBlockNumber()
  const from = prev ? prev.scannedTo + 1n : DEPLOY_BLOCK
  if (prev && from > head) return prev
  const ids = new Set((prev?.ids ?? []).map(String))
  for (let a = from; a <= head; a += LOG_CHUNK) {
    const b = a + LOG_CHUNK - 1n > head ? head : a + LOG_CHUNK - 1n
    const logs = await rpc.getContractEvents({ address: MARKET_ADDRESS, abi: marketAbi, eventName: 'Bought', args: { user: who }, fromBlock: a, toBlock: b })
    for (const l of logs) if (l.args.marketId !== undefined) ids.add(String(l.args.marketId))
  }
  return { ids: [...ids].map((id) => BigInt(id)), scannedTo: head }
}

interface RawOrder {
  stopPrice: bigint
  takeProfitPrice: bigint
}

function toPosition(pos: readonly bigint[], up: RawOrder, down: RawOrder): MyPosition {
  return {
    upUnits: pos[0],
    downUnits: pos[1],
    upCost: pos[2],
    downCost: pos[3],
    upOrder: { stopPrice: up.stopPrice, takeProfitPrice: up.takeProfitPrice },
    downOrder: { stopPrice: down.stopPrice, takeProfitPrice: down.takeProfitPrice },
  }
}

const MULTICALL_CHUNK = 30 // markets per request (3 calls each)

/** Positions in many markets with one batched request per chunk, so the RPC's in-flight limit is never hit. */
export async function fetchPositions(ids: bigint[], who: Address): Promise<MyPosition[]> {
  const out: MyPosition[] = []
  for (let a = 0; a < ids.length; a += MULTICALL_CHUNK) {
    const chunk = ids.slice(a, a + MULTICALL_CHUNK)
    const contracts = chunk.flatMap((id) => [
      { ...market, functionName: 'getPosition', args: [id, who] },
      { ...market, functionName: 'getOrder', args: [id, who, true] },
      { ...market, functionName: 'getOrder', args: [id, who, false] },
    ])
    // The call list mixes two functions, so its element type can't be inferred; results are read back by position.
    const res = (await rpc.multicall({ contracts: contracts as never, allowFailure: false })) as unknown as [readonly bigint[], RawOrder, RawOrder][] | unknown[]
    for (let k = 0; k < chunk.length; k++) {
      out.push(toPosition(res[k * 3] as readonly bigint[], res[k * 3 + 1] as RawOrder, res[k * 3 + 2] as RawOrder))
    }
  }
  return out
}

export async function fetchPosition(id: bigint, who: Address): Promise<MyPosition> {
  return (await fetchPositions([id], who))[0]
}

export function useMarkets() {
  const q = useQuery({ queryKey: qk.markets, queryFn: fetchMarkets, ...LIVE })
  return { markets: q.data ?? [], isLoading: q.isPending }
}

export const oracleSpotQuery = (assetId: number) => ({
  queryKey: qk.oracle(assetId),
  queryFn: async (): Promise<OracleSpot> => {
    const [price, updatedAt] = await rpc.readContract({ ...oracle, functionName: 'getPrice', args: [assetId] })
    return { price, updatedAt: Number(updatedAt) }
  },
  ...LIVE,
})

export function useOracleSpot(assetId: number) {
  return useQuery(oracleSpotQuery(assetId)).data
}

export interface SeriesPoint {
  t: number
  p: number
}

/** Oracle updates seen this session, appended by the realtime sync. Used as the chart fallback line. */
export function useOracleSeries(assetId: number): SeriesPoint[] {
  return (
    useQuery({ queryKey: qk.oracleSeries(assetId), queryFn: (): SeriesPoint[] => [], ...LIVE, initialData: [] as SeriesPoint[] }).data ?? []
  )
}

/** How far a custom strike may sit from spot (1e18 = 100%), as the contract enforces it. */
export function useMaxStrikeDeviation(): bigint {
  return (
    useQuery({ queryKey: qk.strikeDeviation, queryFn: () => rpc.readContract({ ...market, functionName: 'maxStrikeDeviation' }), ...LIVE }).data ??
    DEFAULT_MAX_STRIKE_DEVIATION
  )
}

/** Volatility the contract prices an asset with. It moves with every feed update, so the realtime sync refetches it then. */
export const sigmaQuery = (assetId: number) => ({
  queryKey: qk.sigma(assetId),
  queryFn: async () => Number((await rpc.readContract({ ...oracle, functionName: 'getVol', args: [assetId] })) / 10n ** 9n) / 1e9,
  ...LIVE,
})

export const edgeQuery = {
  queryKey: qk.params,
  queryFn: async () => Number((await rpc.readContract({ ...market, functionName: 'priceEdge' })) / 10n ** 9n) / 1e9,
  ...LIVE,
}

/** Volatility and fee parameters the contract prices with. */
export function usePricingParams(assetId: number) {
  const sigma = useQuery(sigmaQuery(assetId)).data
  const edge = useQuery(edgeQuery).data
  return { sigma, edge }
}

export function positionQueryOptions(id: bigint | undefined, who: Address | undefined) {
  return {
    queryKey: qk.position(id ?? 0n, who ?? ''),
    queryFn: () => fetchPosition(id as bigint, who as Address),
    enabled: id !== undefined && !!who,
    ...LIVE,
    // Each market has its own key: the previous market's position (and its orders) must not show under a new one.
    placeholderData: undefined,
  }
}

/** The wallet's position in one market. undefined while it loads and when there is no market. */
export function usePosition(id: bigint | undefined, who: Address | undefined) {
  const q = useQuery(positionQueryOptions(id, who))
  return { position: !who ? EMPTY_POSITION : id === undefined ? undefined : q.data, refetch: q.refetch }
}

export function useUsdc(who: Address | undefined) {
  const q = useQuery({
    queryKey: qk.usdc(who ?? ''),
    queryFn: async () => {
      const [balance, allowance] = await Promise.all([
        rpc.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [who as Address] }),
        rpc.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'allowance', args: [who as Address, MARKET_ADDRESS] }),
      ])
      return { balance, allowance }
    },
    enabled: !!who,
    ...LIVE,
  })
  return { balance: q.data?.balance, allowance: q.data?.allowance, refetch: q.refetch }
}

export function useVault(who: Address | undefined) {
  return useQuery({
    queryKey: qk.vault(who ?? ''),
    queryFn: async () => {
      const stats = await rpc.readContract({ ...market, functionName: 'vaultStats' })
      const [shares, unlockAt] = who
        ? await Promise.all([
            rpc.readContract({ ...market, functionName: 'sharesOf', args: [who] }),
            rpc.readContract({ ...market, functionName: 'depositUnlockAt', args: [who] }),
          ])
        : [0n, 0n]
      return { stats, shares, unlockAt: Number(unlockAt) }
    },
    ...LIVE,
  })
}

export function usePreviewWithdraw(shares: bigint) {
  return useQuery({
    queryKey: qk.preview(shares),
    queryFn: () => rpc.readContract({ ...market, functionName: 'previewWithdraw', args: [shares] }),
    enabled: shares > 0n,
    ...LIVE,
  }).data
}

/** Ended markets where a wallet has nothing left to claim. They can't change again, so they are not re-read. */
const finished = new Set<string>()

const claimableIn = (m: Market, p: MyPosition) => (m.status === 1 ? (m.upWon ? p.upUnits : p.downUnits) : m.status === 2 ? p.upCost + p.downCost : 0n)

/**
 * The user's positions across the recent markets plus every older market they bought into, as one query so
 * the table updates as one unit. Older markets come from the wallet's own Bought logs, so a win or refund
 * stays claimable however long ago the market ended.
 */
export function usePositions(who: Address | undefined, recent: Market[]) {
  const qc = useQueryClient()
  const mine = useQuery({
    queryKey: qk.myMarkets(who ?? ''),
    queryFn: () => scanMyMarketIds(who as Address, qc.getQueryData<MyMarketIds>(qk.myMarkets(who ?? ''))),
    enabled: !!who,
    ...LIVE,
  })
  const ids = recent.map((m) => String(m.id)).join(',')
  const myIds = mine.data?.ids
  return useQuery({
    queryKey: [...qk.positions(who ?? ''), ids, myIds?.length ?? -1],
    queryFn: () => fetchMyPositions(who as Address, recent, myIds ?? []),
    enabled: !!who && (recent.length > 0 || (myIds?.length ?? 0) > 0),
    ...LIVE,
  })
}

/** Positions with units in the recent markets and in the wallet's older markets (skipping finished ones). */
export async function fetchMyPositions(who: Address, recent: Market[], myIds: bigint[]): Promise<{ market: Market; position: MyPosition }[]> {
  const inRecent = new Set(recent.map((m) => String(m.id)))
  const older = myIds.filter((id) => !inRecent.has(String(id)) && !finished.has(`${who}:${id}`))
  const markets = [...recent, ...(await fetchMarketsById(older))]
  const list = await fetchPositions(
    markets.map((m) => m.id),
    who,
  )
  const rows = markets.map((m, i) => ({ market: m, position: list[i] }))
  for (const r of rows) if (r.market.status !== 0 && claimableIn(r.market, r.position) === 0n) finished.add(`${who}:${r.market.id}`)
  return rows.filter((r) => r.position.upUnits > 0n || r.position.downUnits > 0n)
}

/** Markets by id for labels (History). Cached, since ended markets don't change. */
export function useMarketsById(ids: bigint[]) {
  const key = [...new Set(ids.map(String))].sort().join(',')
  return useQuery({
    queryKey: qk.marketsById(key),
    queryFn: () => fetchMarketsById(key === '' ? [] : key.split(',').map((id) => BigInt(id))),
    enabled: key !== '',
    ...LIVE,
  }).data
}
