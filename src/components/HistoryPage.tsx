import { useMemo } from 'react'
import { useAccount } from 'wagmi'
import { ExternalLink } from 'lucide-react'
import { useMarkets, useMarketsById } from '@/hooks/data'
import { useHistory, type HistoryItem } from '@/hooks/history'
import { assetKey, CHAIN_ID, type Market } from '@/lib/contracts'
import { fmtDurationLong, fmtStrike, fmtUsdc } from '@/lib/format'
import { Skeleton } from '@/components/ui/skeleton'
import { buildTxExplorerUrl } from '@/onchain-facts'
import { cn } from '@/lib/utils'

const COLS = 'grid grid-cols-[170px_1.4fr_1.4fr_1.6fr_40px] items-center gap-4'

const when = (ms: number) =>
  new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

function describe(i: HistoryItem): { action: string; tone?: string; detail: string } {
  const side = i.isUp === undefined ? '' : i.isUp ? 'Up' : 'Down'
  const usd = (v?: bigint) => `$${fmtUsdc(v ?? 0n)}`
  switch (i.kind) {
    case 'bought':
      return { action: `Bought ${side}`, detail: `Paid ${usd(i.amount)} for a ${usd(i.units)} payout` }
    case 'sold':
      return { action: `Sold ${side}`, detail: `Received ${usd(i.amount)}` }
    case 'claimed':
      return { action: 'Claimed', tone: 'text-up', detail: `Received ${usd(i.amount)}` }
    case 'order-set': {
      const parts = [i.stop ? `Stop loss ${fmtStrike(i.stop)}` : '', i.takeProfit ? `Take profit ${fmtStrike(i.takeProfit)}` : ''].filter(Boolean)
      return { action: `Set order on ${side}`, detail: parts.join(', ') }
    }
    case 'order-cancelled':
      return { action: `Removed order on ${side}`, detail: '' }
    case 'order-hit':
      return { action: i.trigger === 1 ? 'Stop loss hit' : 'Take profit hit', tone: i.trigger === 1 ? 'text-down' : 'text-up', detail: `Sold ${side} for ${usd(i.amount)}` }
    case 'deposited':
      return { action: 'Deposited to vault', detail: usd(i.amount) }
    case 'withdrawn':
      return { action: 'Withdrew from vault', detail: usd(i.amount) }
    case 'created':
      return { action: 'Opened a market', detail: '' }
    case 'settled':
      return i.result === 'won'
        ? { action: 'You won', tone: 'text-up', detail: `${i.upWon ? 'Up' : 'Down'} won. Payout ${usd(i.amount)}` }
        : { action: 'You lost', tone: 'text-down', detail: `${i.upWon ? 'Up' : 'Down'} won` }
    default:
      return { action: i.kind, detail: '' }
  }
}

function marketName(id: bigint | undefined, byId: Map<string, Market>): string {
  if (id === undefined) return ''
  const m = byId.get(String(id))
  if (!m) return `Market #${id}`
  return `${assetKey(m.assetId)} ${fmtDurationLong(m.expiry - m.createdAt)} · Strike ${fmtStrike(m.strike)}`
}

export function HistoryPage() {
  const { address } = useAccount()
  const { markets } = useMarkets()
  const history = useHistory(address)
  // Markets older than the recent list are read by id, so every row gets a name.
  const recentIds = useMemo(() => new Set(markets.map((m) => String(m.id))), [markets])
  const olderIds = useMemo(() => [...new Set((history.data?.items ?? []).flatMap((i) => (i.marketId !== undefined && !recentIds.has(String(i.marketId)) ? [i.marketId] : [])))], [history.data, recentIds])
  const older = useMarketsById(olderIds)
  const byId = useMemo(() => new Map([...(older ?? []), ...markets].map((m) => [String(m.id), m])), [markets, older])
  const items = useMemo(() => [...(history.data?.items ?? [])].sort((a, b) => b.time - a.time || Number(b.block - a.block) || b.logIndex - a.logIndex), [history.data])

  return (
    <section className="card flex min-h-[calc(100dvh-132px)] flex-col gap-4">
      <h1 className="flex h-9 items-center text-2xl font-semibold">History</h1>
      {!address ? (
        <div className="grid flex-1 place-items-center text-sm text-dim">Connect a wallet to see your history</div>
      ) : history.isPending ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-inner" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="grid flex-1 place-items-center text-sm text-dim">No activity yet</div>
      ) : (
        <div className="no-scrollbar flex-1 overflow-auto">
          <div className="min-w-[820px] space-y-1">
            <div className={cn(COLS, 'px-4 pb-1 text-sm text-dim')}>
              <span>Time</span>
              <span>Action</span>
              <span>Market</span>
              <span>Details</span>
              <span />
            </div>
            {items.map((i) => {
              const d = describe(i)
              return (
                <div key={i.key} className={cn(COLS, 'rounded-inner bg-raised px-4 py-3 text-sm')}>
                  <span className="num text-dim">{when(i.time)}</span>
                  <span className={cn('text-base font-medium', d.tone)}>{d.action}</span>
                  <span className="num">{marketName(i.marketId, byId)}</span>
                  <span className="num text-dim">{d.detail}</span>
                  <a className="justify-self-end text-dim transition hover:text-white" href={buildTxExplorerUrl(CHAIN_ID, i.tx)} target="_blank" rel="noopener noreferrer" aria-label="View transaction">
                    <ExternalLink size={16} />
                  </a>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
