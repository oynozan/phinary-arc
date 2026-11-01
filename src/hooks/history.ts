import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { parseEventLogs, type Address, type Hex } from 'viem'
import { marketAbi } from '@/lib/abis'
import { DEPLOY_BLOCK, MARKET_ADDRESS } from '@/lib/contracts'
import { rpc } from '@/lib/realtime'
import { qk } from './data'

export type HistoryKind = 'created' | 'bought' | 'sold' | 'claimed' | 'order-set' | 'order-cancelled' | 'order-hit' | 'deposited' | 'withdrawn' | 'settled'

export interface HistoryItem {
  key: string
  kind: HistoryKind
  marketId?: bigint
  isUp?: boolean
  /** USDC raw (6 decimals), when the action moved money */
  amount?: bigint
  /** payout units, when relevant */
  units?: bigint
  stop?: bigint
  takeProfit?: bigint
  /** 1 = stop loss, 2 = take profit */
  trigger?: number
  /** settlement: did the user win, lose, or have no exposure */
  result?: 'won' | 'lost'
  upWon?: boolean
  block: bigint
  logIndex: number
  tx: Hex
  /** ms */
  time: number
}

interface HistoryData {
  items: HistoryItem[]
  scannedTo: bigint
  /** net units per market (carried between incremental scans) */
  net: Map<string, { up: bigint; down: bigint }>
}

const CHUNK = 10_000n
const blockTimes = new Map<bigint, number>()

async function blockTime(block: bigint): Promise<number> {
  const cached = blockTimes.get(block)
  if (cached) return cached
  const b = await rpc.getBlock({ blockNumber: block })
  const t = Number(b.timestamp) * 1000
  blockTimes.set(block, t)
  return t
}

async function scan(who: Address, from: bigint, to: bigint, net: Map<string, { up: bigint; down: bigint }>): Promise<HistoryItem[]> {
  const raw: Omit<HistoryItem, 'time'>[] = []
  const mine = who.toLowerCase()
  const settled: { marketId: bigint; upWon: boolean; block: bigint; logIndex: number; tx: Hex }[] = []

  for (let start = from; start <= to; start += CHUNK) {
    const end = start + CHUNK - 1n > to ? to : start + CHUNK - 1n
    const logs = parseEventLogs({ abi: marketAbi, logs: await rpc.getLogs({ address: MARKET_ADDRESS, fromBlock: start, toBlock: end }) })
    for (const l of logs) {
      if (l.blockNumber === null || l.logIndex === null || l.transactionHash === null) continue
      const base = { key: `${l.transactionHash}-${l.logIndex}`, block: l.blockNumber, logIndex: l.logIndex, tx: l.transactionHash }
      const a = l.args as Record<string, unknown>
      const isMine = typeof a.user === 'string' && a.user.toLowerCase() === mine
      const bump = (id: bigint, isUp: boolean, units: bigint) => {
        const k = String(id)
        const cur = net.get(k) ?? { up: 0n, down: 0n }
        if (isUp) cur.up += units
        else cur.down += units
        net.set(k, cur)
      }
      switch (l.eventName) {
        case 'MarketCreated':
          if (String(a.creator).toLowerCase() === mine) raw.push({ ...base, kind: 'created', marketId: a.marketId as bigint })
          break
        case 'Bought':
          if (isMine) {
            raw.push({ ...base, kind: 'bought', marketId: a.marketId as bigint, isUp: a.isUp as boolean, amount: a.cost as bigint, units: a.units as bigint })
            bump(a.marketId as bigint, a.isUp as boolean, a.units as bigint)
          }
          break
        case 'Sold':
          if (isMine) {
            raw.push({ ...base, kind: 'sold', marketId: a.marketId as bigint, isUp: a.isUp as boolean, amount: a.proceeds as bigint, units: a.units as bigint })
            bump(a.marketId as bigint, a.isUp as boolean, -(a.units as bigint))
          }
          break
        case 'Claimed':
          if (isMine) raw.push({ ...base, kind: 'claimed', marketId: a.marketId as bigint, amount: a.amount as bigint })
          break
        case 'OrderSet':
          if (isMine) raw.push({ ...base, kind: 'order-set', marketId: a.marketId as bigint, isUp: a.isUp as boolean, stop: a.stopPrice as bigint, takeProfit: a.takeProfitPrice as bigint })
          break
        case 'OrderCancelled':
          if (isMine) raw.push({ ...base, kind: 'order-cancelled', marketId: a.marketId as bigint, isUp: a.isUp as boolean })
          break
        case 'OrderExecuted':
          if (isMine) {
            raw.push({ ...base, kind: 'order-hit', marketId: a.marketId as bigint, isUp: a.isUp as boolean, amount: a.proceeds as bigint, units: a.units as bigint, trigger: Number(a.triggered) })
            bump(a.marketId as bigint, a.isUp as boolean, -(a.units as bigint))
          }
          break
        case 'Deposited':
          if (isMine) raw.push({ ...base, kind: 'deposited', amount: a.amount as bigint })
          break
        case 'Withdrawn':
          if (isMine) raw.push({ ...base, kind: 'withdrawn', amount: a.amount as bigint })
          break
        case 'Settled':
          settled.push({ marketId: a.marketId as bigint, upWon: a.upWon as boolean, block: l.blockNumber, logIndex: l.logIndex, tx: l.transactionHash })
          break
        default:
          break
      }
    }
  }

  // One result row per market the user traded in that has settled.
  for (const s of settled) {
    const pos = net.get(String(s.marketId))
    if (!pos || (pos.up <= 0n && pos.down <= 0n)) continue
    const winning = s.upWon ? pos.up : pos.down
    raw.push({
      key: `settled-${s.marketId}`,
      kind: 'settled',
      marketId: s.marketId,
      upWon: s.upWon,
      result: winning > 0n ? 'won' : 'lost',
      amount: winning > 0n ? winning : undefined,
      block: s.block,
      logIndex: s.logIndex,
      tx: s.tx,
    })
  }

  const blocks = [...new Set(raw.map((r) => r.block))]
  await Promise.all(blocks.map((b) => blockTime(b)))
  return raw.map((r) => ({ ...r, time: blockTimes.get(r.block) ?? 0 }))
}

/** Every action by this wallet, scanned once from the deployment block and extended as new events arrive. */
export function useHistory(who: Address | undefined) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: qk.history(who ?? ''),
    queryFn: async (): Promise<HistoryData> => {
      const prev = qc.getQueryData<HistoryData>(qk.history(who ?? ''))
      const head = await rpc.getBlockNumber()
      const from = prev ? prev.scannedTo + 1n : DEPLOY_BLOCK
      if (from > head) return prev as HistoryData
      const net = new Map(prev?.net ?? [])
      const fresh = await scan(who as Address, from, head, net)
      const seen = new Set((prev?.items ?? []).map((i) => i.key))
      return { items: [...(prev?.items ?? []), ...fresh.filter((i) => !seen.has(i.key))], scannedTo: head, net }
    },
    enabled: !!who,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  })
}
