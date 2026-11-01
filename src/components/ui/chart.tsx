/**
 * shadcn/ui chart primitives (ChartContainer, ChartStyle, ChartTooltip, ChartTooltipContent)
 * over Recharts, trimmed to what this app uses.
 */
import * as React from 'react'
import * as RechartsPrimitive from 'recharts'
import { cn } from '@/lib/utils'

export type ChartConfig = Record<string, { label?: React.ReactNode; color?: string }>

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null)

export function useChart() {
  const ctx = React.useContext(ChartContext)
  if (!ctx) throw new Error('useChart must be used within a <ChartContainer />')
  return ctx
}

export function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colors = Object.entries(config).filter(([, c]) => c.color)
  if (colors.length === 0) return null
  const css = `[data-chart=${id}] {\n${colors.map(([key, c]) => `  --color-${key}: ${c.color};`).join('\n')}\n}`
  return <style dangerouslySetInnerHTML={{ __html: css }} />
}

interface ChartContainerProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  config: ChartConfig
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children']
}

export function ChartContainer({ id, className, children, config, ...props }: ChartContainerProps) {
  const uniqueId = React.useId()
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, '')}`
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        className={cn(
          'flex w-full justify-center text-xs',
          '[&_.recharts-cartesian-axis-tick_text]:fill-white/85 [&_.recharts-cartesian-axis-tick_text]:font-num',
          '',
          '[&_.recharts-layer]:outline-none [&_.recharts-surface]:overflow-visible [&_.recharts-wrapper]:outline-none',
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer initialDimension={{ width: 800, height: 360 }}>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

export const ChartTooltip = RechartsPrimitive.Tooltip

interface TooltipEntry {
  value?: number | string
  dataKey?: string | number
  color?: string
}

interface ChartTooltipContentProps {
  active?: boolean
  payload?: TooltipEntry[]
  label?: number | string
  labelFormatter?: (label: number | string) => React.ReactNode
  valueFormatter?: (value: number) => React.ReactNode
}

export function ChartTooltipContent({ active, payload, label, labelFormatter, valueFormatter }: ChartTooltipContentProps) {
  const { config } = useChart()
  if (!active || !payload?.length) return null
  return (
    <div className="grid min-w-[8rem] gap-1.5 rounded-inner bg-hover px-3 py-2 shadow-xl">
      {label !== undefined && (
        <div className="num text-xs text-dim">{labelFormatter ? labelFormatter(label) : label}</div>
      )}
      {payload.map((item) => {
        const key = String(item.dataKey ?? '')
        const entry = config[key]
        const value = Number(item.value)
        return (
          <div key={key} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-dim">
              <span className="h-2 w-2 rounded-full" style={{ background: item.color ?? entry?.color }} />
              {entry?.label ?? key}
            </span>
            <span className="num font-semibold text-white">{valueFormatter ? valueFormatter(value) : value}</span>
          </div>
        )
      })}
    </div>
  )
}
