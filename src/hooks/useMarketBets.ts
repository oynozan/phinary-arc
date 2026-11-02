import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { marketAbi } from '@/lib/abis'
import { DEPLOY_BLOCK, MARKET_ADDRESS } from '@/lib/contracts'
import { rpc } from '@/lib/realtime'
import { qk } from './data'

export interface Bet {
  key: string
  user: Address
  isUp: boolean
  units: bigint
  cost: bigint
  /** unix seconds */
  timestamp: number
  /** oracle price at the bet, 1e18 */
  oraclePrice: bigint
}

const LOOKBACK_BLOCKS = 30_000n
const CHUNK = 5_000n

/** Live bets that arrived while a market's scan was running. The scan stops at the head it read first, so they are merged in. */
const arrivedDuringScan = new Map<string, Bet[]>()

export function holdBetForScan(marketId: bigint, bet: Bet): void {
  const k = String(marketId)
  arrivedDuringScan.set(k, [...(arrivedDuringScan.get(k) ?? []), bet])
}

async function fetchBets(marketId: bigint): Promise<Bet[]> {
  const head = await rpc.getBlockNumber()
  const start = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n
  const from = start > DEPLOY_BLOCK ? start : DEPLOY_BLOCK
  const bets: Bet[] = []
  for (let a = from; a <= head; a += CHUNK) {
    const b = a + CHUNK - 1n > head ? head : a + CHUNK - 1n
    const logs = await rpc.getContractEvents({ address: MARKET_ADDRESS, abi: marketAbi, eventName: 'Bought', args: { marketId }, fromBlock: a, toBlock: b })
    for (const l of logs) {
      const x = l.args
      if (!x.user || x.isUp === undefined || x.units === undefined) continue
      bets.push({
        key: `${l.transactionHash}-${l.logIndex}`,
        user: x.user,
        isUp: x.isUp,
        units: x.units,
        cost: x.cost ?? 0n,
        timestamp: Number(x.timestamp ?? 0n),
        oraclePrice: x.oraclePrice ?? 0n,
      })
    }
  }
  const held = arrivedDuringScan.get(String(marketId)) ?? []
  arrivedDuringScan.delete(String(marketId))
  for (const bet of held) if (!bets.some((b) => b.key === bet.key)) bets.push(bet)
  return bets
}

export function betsQueryOptions(marketId: bigint | undefined) {
  return {
    queryKey: qk.bets(marketId ?? 0n),
    queryFn: () => fetchBets(marketId as bigint),
    enabled: marketId !== undefined,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  }
}

/** Bets on a market: scanned once, then appended live by the realtime sync. */
export function useMarketBets(marketId: bigint | undefined) {
  const q = useQuery(betsQueryOptions(marketId))
  return { bets: q.data ?? [], loading: q.isPending }
}
