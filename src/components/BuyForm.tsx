import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { useModal } from 'connectkit'
import { useAccount, usePublicClient } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { erc20Abi, formatUnits, parseEventLogs } from 'viem'
import { ArrowDown, ArrowUp, ChevronDown, Loader2 } from 'lucide-react'
import { OrderFields, validateOrder } from '@/components/OrderFields'
import type { OrderLines } from '@/components/PriceChart'
import { HelpTip } from '@/components/ui/help-tip'
import { qk, useMarkets, useMaxStrikeDeviation, useOracleSpot, usePricingParams, useUsdc } from '@/hooks/data'
import { findStrikeMarket } from '@/hooks/useMarkets'
import { parseOnchainError, useTx } from '@/hooks/useTx'
import { marketAbi } from '@/lib/abis'
import { chainFromQuote, fetchChainQuote, GAS_RESERVE, MIN_TIME_TO_BET_S, needsApproval, ORACLE_WAIT_MESSAGE, sizeBuy, spendable, UNLIMITED_ALLOWANCE, worstBuyPrice } from '@/lib/bet'
import { rpc } from '@/lib/realtime'
import { CHAIN_ID, MARKET, MARKET_ADDRESS, ORACLE, USDC_ADDRESS, WAD, type AssetMeta, type Market, type Quote } from '@/lib/contracts'
import { costOf, fmtCents, fmtUsdc, parseUsdcInput, unitsForStake, wadToNumber } from '@/lib/format'
import { fmtDeviation } from '@/lib/strike'
import { cn } from '@/lib/utils'

const MAX_BUY_PRICE = (WAD * 99n) / 100n
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
  const { edge } = usePricingParams(asset.id)
  const oracleSpot = useOracleSpot(asset.id)?.price
  const maxDeviation = useMaxStrikeDeviation()
  const qc = useQueryClient()
  const publicClient = usePublicClient({ chainId: CHAIN_ID })
  const { write, run, runReceipt, state, busy } = useTx()
  const [isUp, setIsUp] = useState(true)
  const [amount, setAmount] = useState('5')
  const [orders, setOrders] = useState(false)
  const [stop, setStop] = useState('')
  const [tp, setTp] = useState('')

  const price = quote ? (isUp ? quote.buyUp : quote.buyDown) : 0n
  const fair = quote ? (isUp ? quote.fairUp : WAD - quote.fairUp) : 0n
  const stake = parseUsdcInput(amount)
  const insufficient = !!address && balance !== undefined && costOf(unitsForStake(stake, price), price) > spendable(balance)
  // The price can move while the wallet confirms, so the bet carries a worst-case cost. Units always come from the
  // stake at the current price; near the whole balance only that bound is capped at the balance.
  const strike = customStrike ?? market?.strike ?? quote?.spot
  const worst = quote && edge !== undefined && strike !== undefined && price > 0n ? worstBuyPrice(chainFromQuote(quote, edge), wadToNumber(strike), isUp) : price
  const { units, maxCost } = sizeBuy(stake, price, worst, address && !insufficient ? balance : undefined)
  const cost = costOf(units, price)
  const cappedByBalance = maxCost < costOf(units, worst)
  const profit = units - cost
  const fee = cost - (units * fair) / WAD

  // Stop loss / take profit are checked against the exact oracle price, as setOrder does.
  const orderCheck = useMemo(() => (orders ? validateOrder(isUp, oracleSpot, stop, tp) : { stop: 0n, takeProfit: 0n }), [orders, isUp, oracleSpot, stop, tp])
  const hasOrder = orders && (orderCheck.stop > 0n || orderCheck.takeProfit > 0n)

  useEffect(() => {
    if (hasOrder && !orderCheck.error) {
      onDraft({ isUp, stop: Number(formatUnits(orderCheck.stop, 18)), takeProfit: Number(formatUnits(orderCheck.takeProfit, 18)) })
    } else {
      onDraft(undefined)
    }
    return () => onDraft(undefined)
  }, [hasOrder, orderCheck, isUp, onDraft])

  // submit() refuses a bet with under a minute left, so don't offer one (it would send the approval first).
  const tooLate = !!quote && quote.timeLeft < BigInt(MIN_TIME_TO_BET_S)
  const closed = !quote || tooLate || price === 0n || price >= MAX_BUY_PRICE
  const invalid = closed || stale || units <= 0n || insufficient || !!orderCheck.error || !!strikeError

  /** Use the current market, an existing one with the same strike, or open a new one as part of the bet. */
  const resolveMarketId = async (): Promise<bigint | undefined> => {
    if (market && customStrike === undefined) return market.id
    const existing = customStrike !== undefined ? findStrikeMarket(markets, asset.id, duration, customStrike, now / 1000, MIN_TIME_TO_BET_S) : undefined
    if (existing) return existing.id
    const receipt = await runReceipt(undefined, () => write({ ...MARKET, functionName: 'createMarket', args: [asset.id, customStrike ?? 0n, duration] }))
    if (!receipt) return undefined
    return parseEventLogs({ abi: marketAbi, logs: receipt.logs, eventName: 'MarketCreated' })[0]?.args.marketId
  }

  const submit = async () => {
    if (!address) {
      setOpen(true)
      return
    }
    if (stake <= 0n) return
    // One-time unlimited approval, so later bets need a single confirmation.
    if (needsApproval(allowance)) {
      const ok = await run('USDC approved', () => write({ address: USDC_ADDRESS, abi: erc20Abi, chainId: CHAIN_ID, functionName: 'approve', args: [MARKET_ADDRESS, UNLIMITED_ALLOWANCE] }))
      if (!ok) return
      // Record it now, so a bet that fails after this doesn't ask for approval again.
      qc.setQueryData<{ balance: bigint; allowance: bigint }>(qk.usdc(address), (p) => p && { ...p, allowance: UNLIMITED_ALLOWANCE })
    }
    const marketId = await resolveMarketId()
    if (marketId === undefined) return

    // Price against the contract right before sending, and bound it for the time spent confirming.
    let buy: { units: bigint; maxCost: bigint }
    try {
      const [chain, info] = await Promise.all([fetchChainQuote(marketId), rpc.readContract({ ...MARKET, functionName: 'getMarket', args: [marketId] })])
      const current = isUp ? chain.buyUp : chain.buyDown
      if (chain.timeLeft < MIN_TIME_TO_BET_S) {
        toast.error('This market is too close to its deadline. Pick a longer one.')
        return
      }
      if (current === 0n) {
        // Every executable price reads zero while the oracle price is too old for the time left.
        toast.error(chain.sellUp === 0n && chain.sellDown === 0n ? ORACLE_WAIT_MESSAGE : 'Odds are too extreme to bet right now.')
        return
      }
      buy = sizeBuy(stake, current, worstBuyPrice(chain, wadToNumber(info.strike), isUp), balance)
      if (buy.units === 0n) return
      if (buy.maxCost < costOf(buy.units, current)) {
        toast.error('Not enough USDC for this bet at the current price.')
        return
      }
      await publicClient?.simulateContract({ ...MARKET, functionName: 'buy', args: [marketId, isUp, buy.units, buy.maxCost], account: address })
    } catch (e) {
      toast.error(parseOnchainError(e))
      return
    }
    const bought = await run('Bet placed', () => write({ ...MARKET, functionName: 'buy', args: [marketId, isUp, buy.units, buy.maxCost] }))
    if (!bought) return
    if (hasOrder && !orderCheck.error) {
      // The levels were checked before the bet confirmed; check them again against the oracle price now.
      let spotNow = oracleSpot
      try {
        spotNow = (await rpc.readContract({ ...ORACLE, functionName: 'getPrice', args: [asset.id] }))[0]
      } catch {
        /* fall back to the last pushed price */
      }
      const recheck = validateOrder(isUp, spotNow, stop, tp)
      if (recheck.error) {
        toast.error(`Bet placed, but the stop loss and take profit were not set. ${recheck.error} Set them in the Sell tab.`)
        return
      }
      await run('Stop loss and take profit set', () => write({ ...MARKET, functionName: 'setOrder', args: [marketId, isUp, recheck.stop, recheck.takeProfit] }))
    }
  }

  let cta = 'Place bet'
  if (stale) cta = 'Waiting for a fresh oracle price'
  else if (closed) cta = tooLate ? 'Too close to the deadline' : 'Trading closed'
  else if (units <= 0n) cta = 'Enter an amount'
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
            <HelpTip>Optional. Leave it to use the market's strike, or enter your own within {fmtDeviation(maxDeviation)} of the current price. A different strike opens a new market when you place the bet.</HelpTip>
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
            <button className="num text-dim transition hover:text-white" onClick={() => setAmount(formatUnits(spendable(balance), 6))}>
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
        <Row label="You pay" value={`$${fmtUsdc(cost)}`} tip="At the current price. If the price moves while your bet confirms, you pay up to the max cost below." />
        <Row
          label="Max cost"
          value={`$${fmtUsdc(maxCost > cost ? maxCost : cost)}`}
          tone={cappedByBalance ? 'text-brand' : undefined}
          tip={
            cappedByBalance
              ? `The oracle price can move while your bet confirms, and you then pay the new price for the same payout. This is capped at your balance, less $${fmtUsdc(GAS_RESERVE)} kept for gas: if the price moves further, the bet fails and you only pay gas.`
              : 'The oracle price can move while your bet confirms, and you then pay the new price for the same payout. You never pay more than this. If the price moves further, the bet fails and you only pay gas.'
          }
        />
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
            <OrderFields isUp={isUp} spot={oracleSpot} stop={stop} takeProfit={tp} onStop={setStop} onTakeProfit={setTp} error={orderCheck.error} />
          </div>
        )}
      </div>

      <div className="mt-auto space-y-3">
        <div className="flex items-center gap-2">
          <button className={cn('btn flex-1', isUp ? 'btn-up' : 'btn-down')} disabled={busy || (!!address && invalid)} onClick={() => void submit()}>
            {busy && <Loader2 className="animate-spin" size={18} />}
            {cta}
          </button>
          {stale && (
            <HelpTip align="end">
              The contract only trades on a recent oracle price: no older than 2 minutes, and no older than a quarter of the time left in the market. Betting opens again when the keeper pushes the next price.
            </HelpTip>
          )}
        </div>
        {state.status === 'error' && <p className="text-sm text-down">{state.error}</p>}
      </div>
    </div>
  )
}
