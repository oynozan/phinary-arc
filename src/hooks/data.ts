/**
 * Live data layer. Every query reads once over the WebSocket client and is then kept fresh by
 * pushed events (see useRealtimeSync). Nothing polls, and data is never cleared while a refresh
 * is in flight, so the UI does not flash back to a loading state.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { erc20Abi, type Address } from 'viem'
import { rpc } from '@/lib/realtime'
import { MARKET_ADDRESS, ORACLE_ADDRESS, USDC_ADDRESS, type Market } from '@/lib/contracts'
import { marketAbi, oracleAbi } from '@/lib/abis'

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
  position: (id: bigint, who: string) => ['position', String(id), who] as const,
  positions: (who: string) => ['positions', who] as const,
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

export async function fetchMarkets(): Promise<Market[]> {
  const count = await rpc.readContract({ ...market, functionName: 'marketCount' })
  if (count === 0n) return []
  const take = count > 60n ? 60n : count
  const from = count - take + 1n
  const list = await rpc.readContract({ ...market, functionName: 'getMarketsRange', args: [from, take] })
  return list.map((m, i) => ({
    id: from + BigInt(i),
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
  }))
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

export function useOracleSpot(assetId: number) {
  return useQuery({
    queryKey: qk.oracle(assetId),
    queryFn: async (): Promise<OracleSpot> => {
      const [price, updatedAt] = await rpc.readContract({ ...oracle, functionName: 'getPrice', args: [assetId] })
      return { price, updatedAt: Number(updatedAt) }
    },
    ...LIVE,
  }).data
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

/** Volatility and fee parameters the contract prices with. */
export function usePricingParams(assetId: number) {
  const sigma = useQuery({
    queryKey: qk.sigma(assetId),
    queryFn: async () => Number((await rpc.readContract({ ...oracle, functionName: 'getVol', args: [assetId] })) / 10n ** 9n) / 1e9,
    ...LIVE,
  }).data
  const edge = useQuery({
    queryKey: qk.params,
    queryFn: async () => Number((await rpc.readContract({ ...market, functionName: 'priceEdge' })) / 10n ** 9n) / 1e9,
    ...LIVE,
  }).data
  return { sigma, edge }
}

export function usePosition(id: bigint | undefined, who: Address | undefined) {
  const q = useQuery({
    queryKey: qk.position(id ?? 0n, who ?? ''),
    queryFn: () => fetchPosition(id as bigint, who as Address),
    enabled: id !== undefined && !!who,
    ...LIVE,
  })
  return { position: who ? q.data : EMPTY_POSITION, refetch: q.refetch }
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

/** The user's positions across the recent markets, as one query so the table updates as one unit. */
export function usePositions(who: Address | undefined, markets: Market[]) {
  const ids = markets.map((m) => String(m.id)).join(',')
  return useQuery({
    queryKey: [...qk.positions(who ?? ''), ids],
    queryFn: async () => {
      const list = await fetchPositions(markets.map((m) => m.id), who as Address)
      return markets.map((m, i) => ({ id: m.id, position: list[i] })).filter((r) => r.position.upUnits > 0n || r.position.downUnits > 0n)
    },
    enabled: !!who && markets.length > 0,
    ...LIVE,
  })
}
