import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { Line, LineChart, ReferenceDot, ReferenceLine, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import { ChartAvatar } from '@/components/BettorAvatar'
import type { PricePoint } from '@/hooks/useCoinbasePrice'
import type { Bet } from '@/hooks/useMarketBets'
import type { Market } from '@/lib/contracts'
import { fmtClock, fmtPrice, fmtUsdc, shortAddr, wadToNumber } from '@/lib/format'
import { fmtHHMM, priceScale, timeTicks } from '@/lib/chartScale'

const BRAND = '#1083FF'
const UP = '#97CB3D'
const DOWN = '#F44708'
const WHITE = '#FFFFFF'
const CANVAS = '#050F20'
const MAX_POINTS = 500
const MAX_AVATARS = 50
const TOP = 36
const BOTTOM = 28
const TAG_H = 24
const TAG_GAP = 28

const config: ChartConfig = { p: { label: 'Price', color: BRAND } }

export interface OrderLines {
  isUp: boolean
  stop: number
  takeProfit: number
}

interface Props {
  market: Market | undefined
  coinbase: PricePoint[]
  oracleSeries: PricePoint[]
  bets: Bet[]
  me: string | undefined
  orders: OrderLines | undefined
  /** strike the user is previewing; replaces the market's strike line */
  strikeOverride?: number
  now: number
  height: number
}

interface TagSpec {
  key: string
  text: string
  value: number
  bg: string
  fg: string
}

interface ViewBox {
  x?: number
  y?: number
  width?: number
  height?: number
}

const tagWidth = (text: string) => Math.round(text.length * 7.4 + 16)

function priceAt(series: PricePoint[], t: number): number | undefined {
  if (series.length === 0) return undefined
  let lo = 0
  let hi = series.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (series[mid].t < t) lo = mid + 1
    else hi = mid
  }
  const a = series[Math.max(0, lo - 1)]
  const b = series[lo]
  return Math.abs(a.t - t) < Math.abs(b.t - t) ? a.p : b.p
}

/** A price tag that lives in the right gutter, so it never sits on top of the line it labels. */
function Tag({ viewBox, text, bg, fg, dy = 0 }: { viewBox?: ViewBox; text: string; bg: string; fg: string; dy?: number }) {
  if (!viewBox || viewBox.x === undefined || viewBox.y === undefined) return null
  const w = tagWidth(text)
  const x = viewBox.x + (viewBox.width ?? 0) + 8
  const y = viewBox.y + dy - TAG_H / 2
  return (
    <g>
      <rect x={x} y={y} width={w} height={TAG_H} rx={8} fill={bg} />
      <text x={x + w / 2} y={y + TAG_H / 2 + 4.5} textAnchor="middle" fill={fg} fontSize={12} fontWeight={600} fontFamily="Manrope, sans-serif">
        {text}
      </text>
    </g>
  )
}

function DeadlineLabel({ viewBox, text }: { viewBox?: ViewBox; text: string }) {
  if (!viewBox || viewBox.x === undefined || viewBox.y === undefined) return null
  return (
    <text x={viewBox.x} y={viewBox.y - 12} textAnchor="end" fill={WHITE} fillOpacity={0.85} fontSize={12} fontFamily="Manrope, sans-serif">
      {text}
    </text>
  )
}

function PulseDot({ cx, cy }: { cx?: number; cy?: number }) {
  if (cx === undefined || cy === undefined) return <g />
  return (
    <g>
      <motion.circle cx={cx} cy={cy} fill={BRAND} initial={{ r: 4, opacity: 0.5 }} animate={{ r: 13, opacity: 0 }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }} />
      <circle cx={cx} cy={cy} r={5} fill={WHITE} stroke={BRAND} strokeWidth={3} />
    </g>
  )
}

export function PriceChart({ market, coinbase, oracleSeries, bets, me, orders, strikeOverride, now, height }: Props) {
  // Keep the Coinbase line even if the socket drops (it just stops extending); fall back only when there is none.
  const series = coinbase.length >= 2 ? coinbase : oracleSeries
  const nowBucket = Math.floor(now / 10_000) * 10_000

  const view = useMemo(() => {
    const start = market ? market.createdAt * 1000 : nowBucket - 5 * 60_000
    const end = market ? market.expiry * 1000 : nowBucket + 60_000

    const inside = series.filter((s) => s.t >= start && s.t <= end)
    const before = [...series].reverse().find((s) => s.t < start)
    let data: PricePoint[] = before ? [{ t: start, p: before.p }, ...inside] : inside
    if (data.length > MAX_POINTS) {
      const step = Math.ceil(data.length / MAX_POINTS)
      data = data.filter((_, i) => i % step === 0 || i === data.length - 1)
    }
    if (data.length < 2 && series.length > 0) {
      // A brand new market has no points yet: hold the last known price across the window instead of blanking the chart.
      const lastKnown = series[series.length - 1]
      data = [{ t: start, p: lastKnown.p }, { t: Math.max(lastKnown.t, start + 1), p: lastKnown.p }]
    }
    const last = data[data.length - 1]

    const strike = strikeOverride ?? (market ? wadToNumber(market.strike) : undefined)
    const values = data.map((d) => d.p)
    if (strike !== undefined) values.push(strike)
    if (orders?.stop) values.push(orders.stop)
    if (orders?.takeProfit) values.push(orders.takeProfit)
    let min = Math.min(...values)
    let max = Math.max(...values)
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0
      max = 1
    }
    const pad = Math.max((max - min) * 0.12, max * 0.0004)
    const scale = priceScale(min - pad, max + pad)
    const fmtNum = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: scale.decimals, maximumFractionDigits: Math.max(scale.decimals, v < 1000 ? 2 : 0) })

    // Tags in the right gutter, nudged apart so none overlap.
    const specs: TagSpec[] = []
    if (last) specs.push({ key: 'now', text: fmtNum(last.p), value: last.p, bg: BRAND, fg: WHITE })
    if (strike !== undefined) specs.push({ key: 'strike', text: `${strikeOverride !== undefined ? 'New strike' : 'Strike'} ${fmtNum(strike)}`, value: strike, bg: WHITE, fg: CANVAS })
    if (orders?.takeProfit) specs.push({ key: 'tp', text: `TP ${fmtNum(orders.takeProfit)}`, value: orders.takeProfit, bg: UP, fg: CANVAS })
    if (orders?.stop) specs.push({ key: 'sl', text: `SL ${fmtNum(orders.stop)}`, value: orders.stop, bg: DOWN, fg: WHITE })
    const plotH = height - TOP - BOTTOM
    const yOf = (v: number) => ((scale.hi - v) / (scale.hi - scale.lo)) * plotH
    const sorted = [...specs].sort((a, b) => yOf(a.value) - yOf(b.value))
    const dy: Record<string, number> = {}
    let prev = -Infinity
    for (const s of sorted) {
      const natural = yOf(s.value)
      const placed = Math.max(natural, prev + TAG_GAP)
      dy[s.key] = placed - natural
      prev = placed
    }
    const gutter = Math.max(0, ...specs.map((s) => tagWidth(s.text))) + 12
    const yLabels = scale.ticks.map((t) => fmtNum(t))
    const axisWidth = Math.max(...yLabels.map((l) => l.length)) * 7.6 + 4

    // Bets placed close together stack upward instead of overlapping.
    const gap = (end - start) * 0.03
    const placed: number[] = []
    const dots = bets
      .filter((b) => b.timestamp * 1000 >= start && b.timestamp * 1000 <= end)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-MAX_AVATARS)
      .map((b) => {
        const x = b.timestamp * 1000
        const near = placed.filter((p) => Math.abs(p - x) < gap).length
        placed.push(x)
        return { bet: b, x, y: priceAt(series, x) ?? wadToNumber(b.oraclePrice), stack: near * 22 }
      })

    return { start, end, data, last, strike, scale, dy, gutter, axisWidth, fmtNum, dots, ticks: timeTicks(start, end), specs }
  }, [market, series, bets, orders, strikeOverride, nowBucket, height])

  if (view.data.length < 2 || !view.last) {
    return <Skeleton className="w-full rounded-inner" style={{ height }} />
  }
  const tag = (key: string) => view.specs.find((s) => s.key === key)
  const deadline = market ? new Date(view.end).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : ''

  return (
    <ChartContainer config={config} style={{ height }}>
      <LineChart data={view.data} margin={{ top: TOP, right: view.gutter, bottom: 0, left: 0 }}>
        <XAxis dataKey="t" type="number" domain={[view.start, view.end]} ticks={view.ticks} tickFormatter={fmtHHMM} allowDataOverflow tickLine={false} axisLine={false} tickMargin={10} height={BOTTOM} />
        <YAxis
          domain={[view.scale.lo, view.scale.hi]}
          ticks={view.scale.ticks}
          allowDataOverflow
          width={view.axisWidth}
          tickLine={false}
          axisLine={false}
          tickMargin={0}
          tickFormatter={(v: number) => view.fmtNum(v)}
        />
        <ChartTooltip
          cursor={{ stroke: 'rgba(255,255,255,0.25)' }}
          content={<ChartTooltipContent labelFormatter={(l) => fmtClock(Number(l))} valueFormatter={(v) => fmtPrice(v)} />}
        />
        <Line dataKey="p" type="linear" stroke="var(--color-p)" strokeWidth={2.5} dot={false} isAnimationActive={false} />

        {market && (
          <ReferenceLine x={view.end} stroke={WHITE} strokeOpacity={0.35} label={<DeadlineLabel text={`Deadline ${deadline}`} />} />
        )}
        {view.strike !== undefined && tag('strike') && (
          <ReferenceLine y={view.strike} stroke={WHITE} strokeOpacity={0.55} strokeDasharray="5 5" label={<Tag text={tag('strike')!.text} bg={WHITE} fg={CANVAS} dy={view.dy.strike} />} />
        )}
        {orders && orders.takeProfit > 0 && tag('tp') && (
          <ReferenceLine y={orders.takeProfit} stroke={UP} strokeWidth={2} label={<Tag text={tag('tp')!.text} bg={UP} fg={CANVAS} dy={view.dy.tp} />} />
        )}
        {orders && orders.stop > 0 && tag('sl') && (
          <ReferenceLine y={orders.stop} stroke={DOWN} strokeWidth={2} label={<Tag text={tag('sl')!.text} bg={DOWN} fg={WHITE} dy={view.dy.sl} />} />
        )}
        <ReferenceLine y={view.last.p} stroke={BRAND} strokeOpacity={0} label={<Tag text={tag('now')!.text} bg={BRAND} fg={WHITE} dy={view.dy.now} />} />

        {view.dots.map(({ bet, x, y, stack }) => (
          <ReferenceDot
            key={bet.key}
            x={x}
            y={y}
            r={0}
            ifOverflow="visible"
            shape={(p: { cx?: number; cy?: number }) => (
              <ChartAvatar
                cx={p.cx}
                cy={p.cy}
                id={bet.key}
                address={bet.user}
                isUp={bet.isUp}
                mine={!!me && me.toLowerCase() === bet.user.toLowerCase()}
                stack={stack}
                label={`${shortAddr(bet.user)} bet ${bet.isUp ? 'up' : 'down'} for $${fmtUsdc(bet.cost)}`}
              />
            )}
          />
        ))}
        <ReferenceDot x={view.last.t} y={view.last.p} r={0} ifOverflow="visible" shape={(p: { cx?: number; cy?: number }) => <PulseDot cx={p.cx} cy={p.cy} />} />
      </LineChart>
    </ChartContainer>
  )
}
