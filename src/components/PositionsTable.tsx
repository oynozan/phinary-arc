import { useEffect, useMemo, useState } from 'react'
import { useAccount, usePublicClient } from 'wagmi'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { useMarkets, usePositions, type MyPosition } from '@/hooks/data'
import { oracleWaiting, quoteFor, useAllPricing } from '@/hooks/useMarkets'
import { parseOnchainError, useTx } from '@/hooks/useTx'
import { prepareSell } from '@/lib/bet'
import { assetKey, CHAIN_ID, MARKET, TRADING_CLOSE_BUFFER_S, type Market } from '@/lib/contracts'
import { fmtCountdown, fmtDurationLong, fmtStrike, fmtUsdc, proceedsOf, wadToNumber } from '@/lib/format'
import { trackMarket, useTrackedMarkets } from '@/lib/session'
import { HelpTip } from '@/components/ui/help-tip'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

type Phase = 'open' | 'settling' | 'won' | 'lost' | 'voided'

interface Row {
  market: Market
  position: MyPosition
  phase: Phase
  /** claimable USDC (raw) for won or voided markets */
  claimable: bigint
}

const COLS = 'grid grid-cols-[1.2fr_1.5fr_1.2fr_1fr_120px] items-center gap-4'
/** The contract lets anyone void a market still unsettled this long after expiry (VOID_DELAY), refunding every cost. */
const VOID_DELAY_S = 24 * 60 * 60

function phaseOf(m: Market, p: MyPosition, nowS: number): { phase: Phase; claimable: bigint } {
  if (m.status === 0) return { phase: nowS < m.expiry ? 'open' : 'settling', claimable: 0n }
  if (m.status === 2) return { phase: 'voided', claimable: p.upCost + p.downCost }
  const win = m.upWon ? p.upUnits : p.downUnits
  return win > 0n ? { phase: 'won', claimable: win } : { phase: 'lost', claimable: 0n }
}

function Side({ isUp, units, cost }: { isUp: boolean; units: bigint; cost: bigint }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={cn('badge', isUp ? 'bg-up text-canvas' : 'bg-down text-white')}>{isUp ? 'Up' : 'Down'}</span>
      <span className="num">
        ${fmtUsdc(cost)} <span className="text-dim">for</span> ${fmtUsdc(units)}
      </span>
    </div>
  )
}

interface Props {
  now: number
  onPick: (m: Market) => void
  className?: string
}

/**
 * Active bets with live status, and every win or refund still to claim however old its market. Ended markets
 * stay visible this session so the outcome shows up in real time.
 */
export function PositionsTable({ now, onPick, className }: Props) {
  const { address } = useAccount()
  const { markets } = useMarkets()
  const positions = usePositions(address, markets)
  const prices = useAllPricing()
  const tracked = useTrackedMarkets()
  const publicClient = usePublicClient({ chainId: CHAIN_ID })
  const { write, run, busy } = useTx()
  const [working, setWorking] = useState<string | undefined>()
  const nowS = now / 1000

  const rows = useMemo<Row[]>(() => {
    // Recent markets refresh on every market event, so prefer them over the copy fetched with the positions.
    const byId = new Map(markets.map((m) => [String(m.id), m]))
    const out: Row[] = []
    for (const r of positions.data ?? []) {
      const market = byId.get(String(r.market.id)) ?? r.market
      const position = r.position
      const { phase, claimable } = phaseOf(market, position, nowS)
      // After a reload only active bets (and money still to claim) are listed.
      if (phase !== 'open' && !tracked.has(String(market.id)) && claimable === 0n) continue
      out.push({ market, position, phase, claimable })
    }
    return out.sort((a, b) => a.market.expiry - b.market.expiry)
  }, [positions.data, markets, nowS, tracked])

  useEffect(() => {
    for (const r of rows) if (r.phase === 'open') trackMarket(r.market.id)
  }, [rows])

  // Trades revert while the oracle price is too old for the time left, so those rows can't close for now.
  const staleRow = (r: Row) => oracleWaiting(prices.get(r.market.assetId)?.updatedAt, nowS, r.market.expiry - nowS)
  const valueOf = (r: Row): bigint | undefined => {
    const q = quoteFor(prices.get(r.market.assetId), wadToNumber(r.market.strike), r.market.expiry - nowS)
    if (!q) return undefined
    return proceedsOf(r.position.upUnits, q.sellUp) + proceedsOf(r.position.downUnits, q.sellDown)
  }
  const canClose = (r: Row) => r.phase === 'open' && r.market.expiry - nowS > TRADING_CLOSE_BUFFER_S + 3 && !staleRow(r)

  const close = async (r: Row): Promise<boolean> => {
    if (!address) return false
    const sides = [
      { isUp: true, units: r.position.upUnits },
      { isUp: false, units: r.position.downUnits },
    ].filter((s) => s.units > 0n)
    for (const [i, s] of sides.entries()) {
      let minProceeds: bigint
      try {
        minProceeds = await prepareSell(publicClient, address, r.market.id, s.isUp, s.units)
      } catch (e) {
        toast.error(parseOnchainError(e))
        return false
      }
      const label = i === sides.length - 1 ? 'Position closed' : undefined
      if (!(await run(label, () => write({ ...MARKET, functionName: 'sell', args: [r.market.id, s.isUp, s.units, minProceeds] })))) return false
    }
    return true
  }

  const closeOne = async (r: Row) => {
    setWorking(String(r.market.id))
    await close(r)
    setWorking(undefined)
  }
  const closeAll = async () => {
    setWorking('all')
    for (const r of rows.filter(canClose)) if (!(await close(r))) break
    setWorking(undefined)
  }
  const claim = async (r: Row) => {
    setWorking(String(r.market.id))
    await run('Claimed', () => write({ ...MARKET, functionName: 'claim', args: [r.market.id] }))
    setWorking(undefined)
  }
  const voidable = (r: Row) => r.phase === 'settling' && nowS >= r.market.expiry + VOID_DELAY_S
  const voidMarket = async (r: Row) => {
    setWorking(String(r.market.id))
    await run('Market voided', () => write({ ...MARKET, functionName: 'voidMarket', args: [r.market.id] }))
    setWorking(undefined)
  }

  const closable = rows.filter(canClose).length
  const loading = !!address && positions.isPending && markets.length > 0

  return (
    <section className={cn('card flex flex-col gap-4', className)}>
      <div className="flex h-9 items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-medium">
          Positions
          {rows.length > 0 && <span className="badge bg-raised text-white">{rows.length}</span>}
        </h2>
        {closable > 1 && (
          <button className="btn btn-secondary h-9 px-4 text-sm" disabled={busy} onClick={() => void closeAll()}>
            {working === 'all' && <Loader2 className="animate-spin" size={16} />}
            Close all
          </button>
        )}
      </div>

      {!address || (!loading && rows.length === 0) ? (
        <div className="grid flex-1 place-items-center py-8 text-sm text-dim">
          {!address ? (
            'Connect a wallet to see your positions'
          ) : positions.isError ? (
            <span className="flex items-center gap-3">
              Could not load your positions.
              <button className="chip" onClick={() => void positions.refetch()}>
                Retry
              </button>
            </span>
          ) : (
            'No active bets'
          )}
        </div>
      ) : (
        <div className="no-scrollbar flex-1 overflow-auto">
          <div className="min-w-[760px] space-y-1">
            <div className={cn(COLS, 'px-4 pb-1 text-sm text-dim')}>
              <span>Market</span>
              <span>Position</span>
              <span>Value</span>
              <span>Status</span>
              <span />
            </div>
            {loading && rows.length === 0 && [0, 1].map((i) => <Skeleton key={i} className="h-16 w-full rounded-inner" />)}
            {rows.map((r) => {
              const timeLeft = r.market.expiry - nowS
              const value = valueOf(r)
              const cost = r.position.upCost + r.position.downCost
              const isWorking = working === String(r.market.id)
              return (
                <div key={String(r.market.id)} className={cn(COLS, 'rounded-inner bg-raised px-4 py-3')}>
                  <button className="text-left" onClick={() => onPick(r.market)}>
                    <div className="text-base font-medium">
                      {assetKey(r.market.assetId)} <span className="text-dim">{fmtDurationLong(r.market.expiry - r.market.createdAt)}</span>
                    </div>
                    <div className="num text-sm text-dim">Strike {fmtStrike(r.market.strike)}</div>
                  </button>

                  <div className="space-y-1">
                    {r.position.upUnits > 0n && <Side isUp units={r.position.upUnits} cost={r.position.upCost} />}
                    {r.position.downUnits > 0n && <Side isUp={false} units={r.position.downUnits} cost={r.position.downCost} />}
                  </div>

                  <div className="num text-base font-semibold">
                    {r.phase === 'open' && (value !== undefined ? <span className={value >= cost ? 'text-up' : 'text-down'}>${fmtUsdc(value)}</span> : <span className="text-dim">...</span>)}
                    {r.phase === 'settling' && <span className="text-dim">Settling</span>}
                    {r.phase === 'won' && <span className="text-up">Won +${fmtUsdc(r.claimable > cost ? r.claimable - cost : 0n)}</span>}
                    {r.phase === 'lost' && <span className="text-down">Lost -${fmtUsdc(cost)}</span>}
                    {r.phase === 'voided' && <span>Refund ${fmtUsdc(r.claimable)}</span>}
                  </div>

                  <div className="num text-sm text-dim">
                    {r.phase === 'open' && `${fmtCountdown(Math.max(0, timeLeft))} left`}
                    {r.phase === 'settling' && (
                      <span className="inline-flex items-center gap-2 text-white">
                        <Loader2 className="animate-spin" size={14} />
                        Settling
                      </span>
                    )}
                    {(r.phase === 'won' || r.phase === 'lost' || r.phase === 'voided') && 'Ended'}
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    {r.phase === 'open' && staleRow(r) && <HelpTip align="end">Waiting for a fresh oracle price. The contract only trades on a recent one, so closing opens again when the keeper pushes the next price.</HelpTip>}
                    {r.phase === 'open' && (
                      <button className="btn btn-secondary h-9 bg-card px-4 text-sm hover:bg-hover" disabled={busy || !canClose(r)} onClick={() => void closeOne(r)}>
                        {isWorking && <Loader2 className="animate-spin" size={14} />}
                        Close
                      </button>
                    )}
                    {voidable(r) && (
                      <>
                        <HelpTip align="end">This market never settled. Voiding it refunds what everyone paid, and you can then claim your refund.</HelpTip>
                        <button className="btn btn-secondary h-9 bg-card px-4 text-sm hover:bg-hover" disabled={busy} onClick={() => void voidMarket(r)}>
                          {isWorking && <Loader2 className="animate-spin" size={14} />}
                          Void
                        </button>
                      </>
                    )}
                    {r.claimable > 0n && (
                      <button className="btn btn-up h-9 px-4 text-sm" disabled={busy} onClick={() => void claim(r)}>
                        {isWorking && <Loader2 className="animate-spin" size={14} />}
                        Claim
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
