import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { useModal } from 'connectkit'
import { useAccount, usePublicClient } from 'wagmi'
import { toast } from 'sonner'
import { erc20Abi, formatUnits, parseEventLogs } from 'viem'
import { ArrowDown, ArrowUp, ChevronDown, Loader2 } from 'lucide-react'
import { OrderFields, validateOrder } from '@/components/OrderFields'
import type { OrderLines } from '@/components/PriceChart'
import { HelpTip } from '@/components/ui/help-tip'
import { useMarkets } from '@/hooks/data'
import { useUsdc } from '@/hooks/data'
import { parseOnchainError, useTx } from '@/hooks/useTx'
import { marketAbi } from '@/lib/abis'
import { fetchChainQuote, needsApproval, UNLIMITED_ALLOWANCE, worstBuyPrice } from '@/lib/bet'
import { rpc } from '@/lib/realtime'
import { CHAIN_ID, MARKET, MARKET_ADDRESS, TRADING_CLOSE_BUFFER_S, USDC_ADDRESS, WAD, type AssetMeta, type Market, type Quote } from '@/lib/contracts'
import { costOf, fmtCents, fmtUsdc, unitsForStake, wadToNumber } from '@/lib/format'
import { parseUsdc } from '@/onchain-money'
import { cn } from '@/lib/utils'

const MAX_BUY_PRICE = (WAD * 99n) / 100n
/** A bet needs enough time left to survive wallet confirmation (and the 15s closing window). */
const MIN_TIME_TO_BET_S = 60
const CHIPS = ['1', '5', '10', '25']

interface Props {
  asset: AssetMeta
  market: Market | undefined
  duration: number
  quote: Quote | undefined
  stale: boolean
  now: number
  strikeText: string
  onStrikeText: (v: string) => void
  onStrikeReset: () => void
  strikeEdited: boolean
  /** the strike the user typed, when valid and different from the market's */
  customStrike: bigint | undefined
  strikeError: string | undefined
  onDraft: (lines: OrderLines | undefined) => void
}

function safeParse(v: string): bigint {
  try {
    return v.trim() === '' ? 0n : parseUsdc(v)
  } catch {
    return 0n
  }
}

function Row({ label, value, tone, tip }: { label: string; value: string; tone?: string; tip?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="flex items-center gap-1 text-dim">
        {label}
        {tip && <HelpTip>{tip}</HelpTip>}
      </span>
      <span className={cn('num font-semibold', tone)}>{value}</span>
    </div>
  )
}

export function BuyForm({ asset, market, duration, quote, stale, now, strikeText, onStrikeText, onStrikeReset, strikeEdited, customStrike, strikeError, onDraft }: Props) {
  const { address } = useAccount()
  const { setOpen } = useModal()
  const { balance, allowance } = useUsdc(address)
  const { markets } = useMarkets()
  const publicClient = usePublicClient({ chainId: CHAIN_ID })
  const { write, run, runReceipt, state, busy } = useTx()
  const [isUp, setIsUp] = useState(true)
  const [amount, setAmount] = useState('5')
  const [orders, setOrders] = useState(false)
  const [stop, setStop] = useState('')
  const [tp, setTp] = useState('')

  const price = quote ? (isUp ? quote.buyUp : quote.buyDown) : 0n
  const fair = quote ? (isUp ? quote.fairUp : WAD - quote.fairUp) : 0n
  const stake = safeParse(amount)
  const units = unitsForStake(stake, price)
  const cost = costOf(units, price)
  const profit = units - cost
  const fee = cost - (units * fair) / WAD

  const orderCheck = useMemo(() => (orders ? validateOrder(isUp, quote?.spot, stop, tp) : { stop: 0n, takeProfit: 0n }), [orders, isUp, quote?.spot, stop, tp])
  const hasOrder = orders && (orderCheck.stop > 0n || orderCheck.takeProfit > 0n)

  useEffect(() => {
    if (hasOrder && !orderCheck.error) {
      onDraft({ isUp, stop: Number(formatUnits(orderCheck.stop, 18)), takeProfit: Number(formatUnits(orderCheck.takeProfit, 18)) })
    } else {
      onDraft(undefined)
    }
    return () => onDraft(undefined)
  }, [hasOrder, orderCheck, isUp, onDraft])

  const closed = !quote || quote.timeLeft <= BigInt(TRADING_CLOSE_BUFFER_S) || price === 0n || price >= MAX_BUY_PRICE
  const insufficient = !!address && balance !== undefined && cost > balance
  const invalid = closed || stale || units === 0n || insufficient || !!orderCheck.error || !!strikeError

  /** Use the current market, an existing one with the same strike, or open a new one as part of the bet. */
  const resolveMarketId = async (): Promise<bigint | undefined> => {
    const nowS = now / 1000
    if (market && customStrike === undefined) return market.id
    const strike = customStrike ?? 0n
    const existing = markets.find((m) => m.assetId === asset.id && m.status === 0 && m.expiry - m.createdAt === duration && m.expiry - nowS > 60 && customStrike !== undefined && m.strike === strike)
    if (existing) return existing.id
    const receipt = await runReceipt(undefined, () => write({ ...MARKET, functionName: 'createMarket', args: [asset.id, strike, duration] }))
    if (!receipt) return undefined
    return parseEventLogs({ abi: marketAbi, logs: receipt.logs, eventName: 'MarketCreated' })[0]?.args.marketId
  }

  const submit = async () => {
    if (!address) {
      setOpen(true)
      return
    }
    if (stake === 0n) return
    // One-time unlimited approval, so later bets need a single confirmation.
    if (needsApproval(allowance)) {
      const ok = await run('USDC approved', () => write({ address: USDC_ADDRESS, abi: erc20Abi, chainId: CHAIN_ID, functionName: 'approve', args: [MARKET_ADDRESS, UNLIMITED_ALLOWANCE] }))
      if (!ok) return
    }
    const marketId = await resolveMarketId()
    if (marketId === undefined) return

    // Price against the contract right before sending, and bound it for the time spent confirming.
    let buy: { units: bigint; maxCost: bigint }
    try {
      const [chain, info] = await Promise.all([fetchChainQuote(marketId), rpc.readContract({ ...MARKET, functionName: 'getMarket', args: [marketId] })])
      const current = isUp ? chain.buyUp : chain.buyDown
      if (current === 0n || chain.timeLeft < MIN_TIME_TO_BET_S) {
        toast.error('This market is too close to its deadline. Pick a longer one.')
        return
      }
      const betUnits = unitsForStake(stake, current)
      let ceiling = costOf(betUnits, worstBuyPrice(chain, wadToNumber(info.strike), isUp))
      if (balance !== undefined && ceiling > balance) ceiling = balance
      buy = { units: betUnits, maxCost: ceiling }
      await publicClient?.simulateContract({ ...MARKET, functionName: 'buy', args: [marketId, isUp, buy.units, buy.maxCost], account: address })
    } catch (e) {
      toast.error(parseOnchainError(e))
      return
    }
    const bought = await run('Bet placed', () => write({ ...MARKET, functionName: 'buy', args: [marketId, isUp, buy.units, buy.maxCost] }))
    if (!bought) return
    if (hasOrder && !orderCheck.error) {
      await run('Stop loss and take profit set', () => write({ ...MARKET, functionName: 'setOrder', args: [marketId, isUp, orderCheck.stop, orderCheck.takeProfit] }))
    }
  }

  let cta = 'Place bet'
  if (stale) cta = 'Waiting for oracle price'
  else if (closed) cta = 'Trading closed'
  else if (units === 0n) cta = 'Enter an amount'
  else if (insufficient) cta = 'Not enough USDC'
  else if (strikeError) cta = 'Fix the strike'
  else if (orderCheck.error) cta = 'Fix stop loss or take profit'
  else if (state.status === 'signing') cta = 'Confirm in wallet'
  else if (state.status === 'confirming') cta = 'Confirming'

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div className="grid grid-cols-2 gap-3">
        {(
          [
            { up: true, label: 'Up', Icon: ArrowUp, p: quote?.buyUp, on: 'bg-up text-canvas', icon: 'text-up' },
            { up: false, label: 'Down', Icon: ArrowDown, p: quote?.buyDown, on: 'bg-down text-white', icon: 'text-down' },
          ] as const
        ).map((s) => {
          const selected = isUp === s.up
          return (
            <motion.button key={s.label} whileTap={{ scale: 0.98 }} aria-pressed={selected} onClick={() => setIsUp(s.up)} className={cn('h-[88px] rounded-inner p-4 text-left transition-colors', selected ? s.on : 'bg-raised hover:bg-hover')}>
              <div className="flex items-center gap-1.5 text-base font-medium">
                <s.Icon size={18} strokeWidth={2.5} className={selected ? undefined : s.icon} />
                {s.label}
              </div>
              <div className="num text-2xl font-semibold">{s.p !== undefined && s.p > 0n ? fmtCents(s.p) : '--'}</div>
            </motion.button>
          )
        })}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-1 text-dim">
            Strike
            <HelpTip>Optional. Leave it to use the market's strike, or enter your own within 10% of the current price. A different strike opens a new market when you place the bet.</HelpTip>
          </span>
          {strikeEdited && (
            <button className="text-dim underline-offset-2 transition hover:text-white hover:underline" onClick={onStrikeReset}>
              Reset
            </button>
          )}
        </div>
        <div className="relative">
          <span className="num pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-dim">$</span>
          <input className="field pl-8" inputMode="decimal" value={strikeText} onChange={(e) => onStrikeText(e.target.value)} onBlur={() => strikeText.trim() === '' && onStrikeReset()} aria-invalid={!!strikeError} />
        </div>
        {strikeError && <p className="text-sm text-down">{strikeError}</p>}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-dim">Amount</span>
          {address && balance !== undefined && (
            <button className="num text-dim transition hover:text-white" onClick={() => setAmount(formatUnits(balance, 6))}>
              Balance ${fmtUsdc(balance)}
            </button>
          )}
        </div>
        <div className="relative">
          <span className="num pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-dim">$</span>
          <input className="field pl-8 pr-16" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-dim">USDC</span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {CHIPS.map((c) => (
            <button key={c} className="chip" data-active={amount === c} onClick={() => setAmount(c)}>
              ${c}
            </button>
          ))}
        </div>
      </div>

      <div className="panel space-y-2 p-4">
        <Row label="You pay" value={`$${fmtUsdc(cost)}`} tip="This is the most you can lose." />
        <Row label="Payout if you win" value={`$${fmtUsdc(units)}`} />
        <Row label="Profit if you win" value={profit > 0n ? `+$${fmtUsdc(profit)}` : '$0.00'} tone={profit > 0n ? 'text-up' : undefined} />
        <Row label="Chance to win" value={quote ? `${Math.round(wadToNumber(fair) * 100)}%` : '--'} tip="The model's fair probability, before the fee." />
        <Row label="Fee" value={`$${fmtUsdc(fee > 0n ? fee : 0n)}`} tip="The house edge. It is already included in the price above." />
      </div>

      <div>
        <div className="flex h-11 items-center justify-between">
          <span className="flex items-center gap-1.5 text-base font-medium">
            Stop loss and take profit
            <HelpTip>Set price levels on the oracle price. When one is crossed, a keeper sells your whole position, even if you are offline.</HelpTip>
          </span>
          <button aria-label="Toggle stop loss and take profit" aria-expanded={orders} className="chip w-9 px-0" onClick={() => setOrders((o) => !o)}>
            <ChevronDown size={18} className={cn('transition-transform', orders && 'rotate-180')} />
          </button>
        </div>
        {orders && (
          <div className="pt-2">
            <OrderFields isUp={isUp} spot={quote?.spot} stop={stop} takeProfit={tp} onStop={setStop} onTakeProfit={setTp} error={orderCheck.error} />
          </div>
        )}
      </div>

      <div className="mt-auto space-y-3">
        <button className={cn('btn w-full', isUp ? 'btn-up' : 'btn-down')} disabled={busy || (!!address && invalid)} onClick={() => void submit()}>
          {busy && <Loader2 className="animate-spin" size={18} />}
          {cta}
        </button>
        {state.status === 'error' && <p className="text-sm text-down">{state.error}</p>}
      </div>
    </div>
  )
}
