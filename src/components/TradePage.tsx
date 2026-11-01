import { useCallback, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { formatUnits, parseUnits } from 'viem'
import { AnimatedPrice } from '@/components/AnimatedPrice'
import { AssetTabs } from '@/components/AssetTabs'
import { DurationTabs } from '@/components/DurationTabs'
import { PositionsTable } from '@/components/PositionsTable'
import { PriceChart, type OrderLines } from '@/components/PriceChart'
import { TradePanel } from '@/components/TradePanel'
import { HelpTip } from '@/components/ui/help-tip'
import { Skeleton } from '@/components/ui/skeleton'
import { useMarkets, useOracleSeries, usePosition } from '@/hooks/data'
import { useCoinbasePrice } from '@/hooks/useCoinbasePrice'
import { useMarketBets } from '@/hooks/useMarketBets'
import { openByDuration, quoteFor, STALE_AFTER_S, useAssetPricing, useNow } from '@/hooks/useMarkets'
import { ASSETS, type AssetMeta, type Market } from '@/lib/contracts'
import { fmtPrice, wadToNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

interface Props {
  asset: AssetMeta
  onAsset: (a: AssetMeta) => void
  duration: number
  onDuration: (d: number) => void
}

const CHART_HEIGHT = 360
const MAX_STRIKE_DEVIATION = 0.1

export function TradePage({ asset, onAsset, duration, onDuration }: Props) {
  const { address } = useAccount()
  const now = useNow()
  const nowS = now / 1000
  const { markets, isLoading } = useMarkets()
  const pricing = useAssetPricing(asset.id)
  const oracleSeries = useOracleSeries(asset.id)
  const cb = useCoinbasePrice(asset.product)

  const open = useMemo(() => openByDuration(markets, asset.id, Math.floor(now / 1000) * 1000), [markets, asset.id, now])
  const selected = open.get(duration)

  // Optional strike typed by the user. It resets when the asset or duration changes.
  const scope = `${asset.id}-${duration}`
  const [strikeState, setStrikeState] = useState<{ scope: string; text: string | undefined }>({ scope, text: undefined })
  const defaultStrikeNum = selected ? wadToNumber(selected.strike) : pricing.spot
  // The field always holds a real value: the market's strike until the user types something else.
  const defaultStrikeText = defaultStrikeNum !== undefined ? defaultStrikeNum.toFixed(2) : ''
  const edited = strikeState.scope === scope ? strikeState.text : undefined
  const strikeText = edited ?? defaultStrikeText
  const strikeEdited = edited !== undefined && edited.trim() !== defaultStrikeText
  const onStrikeText = (text: string) => setStrikeState({ scope, text })
  const onStrikeReset = () => setStrikeState({ scope, text: undefined })

  const strikeCheck = useMemo(() => {
    const text = strikeText.trim().replace(/,/g, '')
    if (!strikeEdited) return { wad: undefined, error: undefined }
    if (text === '') return { wad: undefined, error: 'Enter a strike price.' }
    let wad: bigint
    try {
      wad = parseUnits(text, 18)
    } catch {
      return { wad: undefined, error: 'Enter a valid price.' }
    }
    const value = Number(text)
    if (!(value > 0)) return { wad: undefined, error: 'Enter a valid price.' }
    if (pricing.spot !== undefined && Math.abs(value / pricing.spot - 1) > MAX_STRIKE_DEVIATION) {
      return { wad: undefined, error: `Strike must be within 10% of ${fmtPrice(pricing.spot, 0)}.` }
    }
    return { wad, error: undefined }
  }, [strikeText, strikeEdited, pricing.spot])
  const customStrike = strikeCheck.wad !== undefined && strikeCheck.wad !== selected?.strike ? strikeCheck.wad : undefined

  const strikeNum = customStrike !== undefined ? wadToNumber(customStrike) : defaultStrikeNum
  const timeLeft = customStrike !== undefined || !selected ? duration : selected.expiry - nowS
  const quote = useMemo(() => quoteFor(pricing, strikeNum, timeLeft), [pricing, strikeNum, timeLeft])
  const marketQuote = useMemo(() => (selected ? quoteFor(pricing, wadToNumber(selected.strike), selected.expiry - nowS) : undefined), [pricing, selected, nowS])
  const stale = pricing.updatedAt !== undefined && nowS - pricing.updatedAt > STALE_AFTER_S

  const { bets } = useMarketBets(selected?.id)
  const { position } = usePosition(selected?.id, address)
  const [draft, setDraft] = useState<OrderLines | undefined>()
  const onDraft = useCallback((d: OrderLines | undefined) => setDraft(d), [])

  const orders = useMemo<OrderLines | undefined>(() => {
    if (draft) return draft
    if (!position) return undefined
    const has = (o: { stopPrice: bigint; takeProfitPrice: bigint }) => o.stopPrice > 0n || o.takeProfitPrice > 0n
    const side = position.upUnits > 0n && has(position.upOrder) ? { isUp: true, o: position.upOrder } : position.downUnits > 0n && has(position.downOrder) ? { isUp: false, o: position.downOrder } : undefined
    if (!side) return undefined
    return { isUp: side.isUp, stop: Number(formatUnits(side.o.stopPrice, 18)), takeProfit: Number(formatUnits(side.o.takeProfitPrice, 18)) }
  }, [draft, position])

  const onPickMarket = useCallback(
    (m: Market) => {
      onAsset(ASSETS[m.assetId])
      onDuration(m.expiry - m.createdAt)
    },
    [onAsset, onDuration],
  )

  const live = cb.status === 'live' && cb.points.length > 0
  const headline = cb.points.length > 0 ? cb.points[cb.points.length - 1].p : pricing.spot
  const diffPct = headline !== undefined && strikeNum ? ((headline - strikeNum) / strikeNum) * 100 : undefined

  return (
    <div className="flex min-h-[calc(100dvh-132px)] flex-col gap-6">
      <div className="grid items-stretch gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="card flex min-w-0 flex-col gap-6">
          <div className="flex items-center justify-between gap-4">
            <AssetTabs value={asset} onChange={onAsset} />
            <div className="flex items-center gap-2 text-sm text-dim">
              <span className={cn('h-2 w-2 rounded-full', live ? 'bg-brand' : 'bg-white/40')} />
              {live ? 'Live' : cb.status === 'connecting' ? 'Connecting' : 'Reconnecting'}
              <HelpTip align="end">
                The line is the live Coinbase price. The dashed line is the strike and the vertical line is the deadline. Avatars mark bets: green ring up, red ring down. Bets settle on the oracle price.
              </HelpTip>
            </div>
          </div>

          <div>
            {headline === undefined ? (
              <Skeleton className="h-11 w-56" />
            ) : (
              <div className="num text-4xl font-semibold">
                <AnimatedPrice value={headline} />
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-4 text-sm text-dim">
              {diffPct !== undefined && strikeNum !== undefined && (
                <span className={diffPct >= 0 ? 'text-up' : 'text-down'}>
                  {Math.abs(diffPct).toFixed(2)}% {diffPct >= 0 ? 'above' : 'below'} the {fmtPrice(strikeNum, 0)} strike
                </span>
              )}
              <span className="num inline-flex items-center gap-1">
                Oracle {pricing.spot !== undefined ? fmtPrice(pricing.spot) : '...'}
                <HelpTip>Bets settle on this testnet oracle price, not the live Coinbase price above.</HelpTip>
              </span>
            </div>
          </div>

          <DurationTabs value={duration} onChange={onDuration} open={open} loading={isLoading} now={now} />

          <PriceChart
            market={selected}
            coinbase={cb.points}
            oracleSeries={oracleSeries}
            bets={bets}
            me={address}
            orders={orders}
            strikeOverride={customStrike !== undefined ? strikeNum : undefined}
            now={now}
            height={CHART_HEIGHT}
          />
        </section>

        <TradePanel
          asset={asset}
          market={selected}
          duration={duration}
          quote={quote}
          marketQuote={marketQuote}
          stale={stale}
          now={now}
          strikeText={strikeText}
          onStrikeText={onStrikeText}
          onStrikeReset={onStrikeReset}
          strikeEdited={strikeEdited}
          customStrike={customStrike}
          strikeError={strikeCheck.error}
          onDraft={onDraft}
        />
      </div>

      <PositionsTable now={now} onPick={onPickMarket} className="min-h-[280px] flex-1" />
    </div>
  )
}
