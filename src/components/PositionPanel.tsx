import { useState } from 'react'
import { toast } from 'sonner'
import { formatUnits } from 'viem'
import { Loader2 } from 'lucide-react'
import { OrderFields, validateOrder } from '@/components/OrderFields'
import { HelpTip } from '@/components/ui/help-tip'
import { useAccount, usePublicClient } from 'wagmi'
import { usePosition, type Order } from '@/hooks/data'
import { parseOnchainError, useTx } from '@/hooks/useTx'
import { prepareSell } from '@/lib/bet'
import { CHAIN_ID, MARKET, TRADING_CLOSE_BUFFER_S, type Market, type Quote } from '@/lib/contracts'
import { fmtUsdc, proceedsOf } from '@/lib/format'
import { cn } from '@/lib/utils'

const PCTS = [25, 50, 75, 100]

const levelStr = (v: bigint) => (v === 0n ? '' : formatUnits(v, 18))

interface SideProps {
  market: Market
  quote: Quote | undefined
  isUp: boolean
  units: bigint
  cost: bigint
  order: Order
  onDone: () => void
}

function SideCard({ market, quote, isUp, units, cost, order, onDone }: SideProps) {
  const { address } = useAccount()
  const publicClient = usePublicClient({ chainId: CHAIN_ID })
  const { write, run, busy } = useTx()
  const [pct, setPct] = useState(100)
  const [stop, setStop] = useState(levelStr(order.stopPrice))
  const [tp, setTp] = useState(levelStr(order.takeProfitPrice))

  const open = market.status === 0 && !!quote && quote.timeLeft > BigInt(TRADING_CLOSE_BUFFER_S)
  const sellPrice = quote ? (isUp ? quote.sellUp : quote.sellDown) : 0n
  const sellUnits = pct === 100 ? units : (units * BigInt(pct)) / 100n
  const proceeds = proceedsOf(sellUnits, sellPrice)
  const value = proceedsOf(units, sellPrice)
  const pnl = value - cost
  const check = validateOrder(isUp, quote?.spot, stop, tp)
  const hasOrder = order.stopPrice > 0n || order.takeProfitPrice > 0n
  const dirty = check.stop !== order.stopPrice || check.takeProfit !== order.takeProfitPrice

  const sell = async () => {
    if (!address) return
    let minProceeds: bigint
    try {
      minProceeds = await prepareSell(publicClient, address, market.id, isUp, sellUnits)
    } catch (e) {
      toast.error(parseOnchainError(e))
      return
    }
    if (await run('Position sold', () => write({ ...MARKET, functionName: 'sell', args: [market.id, isUp, sellUnits, minProceeds] }))) onDone()
  }
  const saveOrder = async () => {
    if (await run('Order saved', () => write({ ...MARKET, functionName: 'setOrder', args: [market.id, isUp, check.stop, check.takeProfit] }))) onDone()
  }
  const cancelOrder = async () => {
    if (await run('Order removed', () => write({ ...MARKET, functionName: 'cancelOrder', args: [market.id, isUp] }))) {
      setStop('')
      setTp('')
      onDone()
    }
  }

  return (
    <div className="panel space-y-4 p-4">
      <div className="flex items-center justify-between">
        <span className={cn('badge', isUp ? 'bg-up text-canvas' : 'bg-down text-white')}>{isUp ? 'Up' : 'Down'}</span>
        <span className="num text-sm text-dim">Pays ${fmtUsdc(units)}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-dim">Cost</div>
          <div className="num font-semibold">${fmtUsdc(cost)}</div>
        </div>
        <div>
          <div className="text-dim">Value now</div>
          <div className={cn('num font-semibold', open && (pnl >= 0n ? 'text-up' : 'text-down'))}>{open ? `$${fmtUsdc(value)}` : '...'}</div>
        </div>
      </div>

      {open && (
        <>
          <div className="grid grid-cols-4 gap-2">
            {PCTS.map((p) => (
              <button key={p} className="chip bg-card hover:bg-hover" data-active={pct === p} onClick={() => setPct(p)}>
                {p}%
              </button>
            ))}
          </div>
          <button className="btn btn-secondary w-full bg-card hover:bg-hover" disabled={busy || sellUnits === 0n} onClick={() => void sell()}>
            {busy && <Loader2 className="animate-spin" size={18} />}
            Sell for ${fmtUsdc(proceeds)}
          </button>

          <div className="space-y-3 pt-2">
            <div className="flex items-center gap-1.5 text-base font-medium">
              Stop loss and take profit
              <HelpTip>Price levels on the oracle price. When one is crossed, a keeper sells your whole position, even if you are offline.</HelpTip>
            </div>
            <OrderFields isUp={isUp} spot={quote?.spot} stop={stop} takeProfit={tp} onStop={setStop} onTakeProfit={setTp} error={check.error} />
            <div className="flex gap-2">
              <button className="btn btn-primary flex-1" disabled={busy || !!check.error || !dirty || (check.stop === 0n && check.takeProfit === 0n)} onClick={() => void saveOrder()}>
                Save
              </button>
              {hasOrder && (
                <button className="btn btn-secondary bg-card hover:bg-hover" disabled={busy} onClick={() => void cancelOrder()}>
                  Remove
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export function PositionPanel({ market, quote }: { market: Market; quote: Quote | undefined }) {
  const { address } = useAccount()
  const { position, refetch } = usePosition(market.id, address)
  const { write, run, busy } = useTx()

  if (!address || !position) return <p className="text-sm text-dim">Connect a wallet to see your position.</p>
  const hasUp = position.upUnits > 0n
  const hasDown = position.downUnits > 0n
  if (!hasUp && !hasDown) return <p className="text-sm text-dim">You have no position in this market.</p>

  const winningUnits = market.status === 1 ? (market.upWon ? position.upUnits : position.downUnits) : 0n
  const refund = market.status === 2 ? position.upCost + position.downCost : 0n
  const claimable = winningUnits + refund

  const claim = async () => {
    await run('Claimed', () => write({ ...MARKET, functionName: 'claim', args: [market.id] }))
    void refetch()
  }

  return (
    <div className="space-y-4">
      {market.status === 1 && (
        <div className={cn('panel p-4 text-base font-medium', claimable > 0n ? 'text-up' : 'text-down')}>
          {claimable > 0n ? `You won $${fmtUsdc(claimable)}` : 'This market settled against you'}
        </div>
      )}
      {market.status === 2 && <div className="panel p-4 text-base font-medium">Voided. Your cost is refunded.</div>}
      {claimable > 0n && (
        <button className="btn btn-up w-full" disabled={busy} onClick={() => void claim()}>
          {busy && <Loader2 className="animate-spin" size={18} />}
          Claim ${fmtUsdc(claimable)}
        </button>
      )}
      {hasUp && <SideCard market={market} quote={quote} isUp units={position.upUnits} cost={position.upCost} order={position.upOrder} onDone={() => void refetch()} />}
      {hasDown && <SideCard market={market} quote={quote} isUp={false} units={position.downUnits} cost={position.downCost} order={position.downOrder} onDone={() => void refetch()} />}
    </div>
  )
}
