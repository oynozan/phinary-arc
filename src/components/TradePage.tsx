import { useCallback, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { formatUnits } from 'viem'
import { AnimatedPrice } from '@/components/AnimatedPrice'
import { AssetTabs } from '@/components/AssetTabs'
import { DurationTabs } from '@/components/DurationTabs'
import { PositionsTable } from '@/components/PositionsTable'
import { PriceChart, type OrderLines } from '@/components/PriceChart'
import { TradePanel } from '@/components/TradePanel'
import { HelpTip } from '@/components/ui/help-tip'
import { Skeleton } from '@/components/ui/skeleton'
import { useMarkets, useMaxStrikeDeviation, useOracleSeries, useOracleSpot, usePosition } from '@/hooks/data'
import { useCoinbasePrice } from '@/hooks/useCoinbasePrice'
import { useKrakenPrice } from '@/hooks/useKrakenPrice'
import { useMarketBets } from '@/hooks/useMarketBets'
import { findStrikeMarket, openByDuration, oracleWaiting, quoteFor, useAssetPricing, useNow } from '@/hooks/useMarkets'
import { MIN_TIME_TO_BET_S } from '@/lib/bet'
import { assetById, type AssetMeta, type Market } from '@/lib/contracts'
import { fmtPrice, fmtStrike, wadToNumber } from '@/lib/format'
import { isTestnet } from '@/lib/network'
import { checkStrike } from '@/lib/strike'
import { cn } from '@/lib/utils'

interface Props {
  asset: AssetMeta
  onAsset: (a: AssetMeta) => void
  duration: number
  onDuration: (d: number) => void
}

const CHART_HEIGHT = 360

export function TradePage({ asset, onAsset, duration, onDuration }: Props) {
  const { address } = useAccount()
  const now = useNow()
  const nowS = now / 1000
  const { markets, isLoading } = useMarkets()
  const pricing = useAssetPricing(asset.id)
  const oracleSpot = useOracleSpot(asset.id)?.price
  const maxDeviation = useMaxStrikeDeviation()
  const oracleSeries = useOracleSeries(asset.id)
  // Both hooks always run (hook order); only the one for this asset's kind connects.
  const coinbase = useCoinbasePrice(asset.kind === 'crypto' ? asset.chart : undefined)
  const kraken = useKrakenPrice(asset.kind === 'stock' ? asset.chart : undefined)
  const cb = asset.kind === 'stock' ? kraken : coinbase
  const venue = asset.kind === 'stock' ? 'Kraken' : 'Coinbase'

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
  // Typing back the displayed strike (even as 77743.790) means the market's own strike, not a new market a fraction of a cent away.
  const typed = edited?.trim().replace(/,/g, '')
  const strikeEdited = typed !== undefined && typed !== defaultStrikeText && !(typed !== '' && Number(typed).toFixed(2) === defaultStrikeText)
  const onStrikeText = (text: string) => setStrikeState({ scope, text })
  const onStrikeReset = () => setStrikeState({ scope, text: undefined })

  const strikeCheck = useMemo(() => (strikeEdited ? checkStrike(strikeText, oracleSpot, maxDeviation) : { wad: undefined, error: undefined }), [strikeText, strikeEdited, oracleSpot, maxDeviation])
  const customStrike = strikeCheck.wad !== undefined && strikeCheck.wad !== selected?.strike ? strikeCheck.wad : undefined
  // A custom strike reuses an open market with that strike when one exists, so preview its real time left.
  const strikeMarket = customStrike !== undefined ? findStrikeMarket(markets, asset.id, duration, customStrike, nowS, MIN_TIME_TO_BET_S) : undefined

  const strikeNum = customStrike !== undefined ? wadToNumber(customStrike) : defaultStrikeNum
  const target = customStrike !== undefined ? strikeMarket : selected
  const timeLeft = target ? target.expiry - nowS : duration
  const quote = useMemo(() => quoteFor(pricing, strikeNum, timeLeft, nowS), [pricing, strikeNum, timeLeft, nowS])
  const marketQuote = useMemo(() => (selected ? quoteFor(pricing, wadToNumber(selected.strike), selected.expiry - nowS, nowS) : undefined), [pricing, selected, nowS])
  // Trades revert on an oracle price past maxTradeStaleness or older than a quarter of the time left.
  const stale = oracleWaiting(pricing.updatedAt, nowS, timeLeft)
  const marketStale = selected !== undefined && oracleWaiting(pricing.updatedAt, nowS, selected.expiry - nowS)

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
      const a = assetById(m.assetId)
      if (!a) return
      onAsset(a)
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
                The line is the live {venue} price. The dashed line is the strike and the vertical line is the deadline. Avatars mark bets: green ring up, red ring down. Bets settle on the oracle price.
                {asset.kind === 'stock' && ` ${asset.name} trades around the clock here: outside US market hours the price comes from tokenized-stock and derivatives venues, so it can drift from the last Nasdaq close.`}
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
                  {Math.abs(diffPct).toFixed(2)}% {diffPct >= 0 ? 'above' : 'below'} the {fmtStrike(strikeNum)} strike
                </span>
              )}
              <span className="num inline-flex items-center gap-1">
                Oracle {pricing.spot !== undefined ? fmtPrice(pricing.spot) : '...'}
                <HelpTip>
                  {isTestnet
                    ? `Bets settle on this testnet oracle price, which the keeper pushes from ${venue}, not on the live price above.`
                    : `Bets settle on this oracle price from Chainlink Data Streams${asset.kind === 'stock' ? ' (its 24/7 stream)' : ''}, not on the live ${venue} price above.`}
                </HelpTip>
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
          marketStale={marketStale}
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
