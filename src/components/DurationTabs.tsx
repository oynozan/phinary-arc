import { motion } from 'framer-motion'
import { DURATIONS } from '@/hooks/useMarkets'
import type { Market } from '@/lib/contracts'
import { fmtCountdown, fmtDurationLong, fmtStrike } from '@/lib/format'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

interface Props {
  value: number
  onChange: (duration: number) => void
  open: Map<number, Market>
  loading: boolean
  now: number
}

/** One tile per standard duration. Each shows the live market for that duration. */
export function DurationTabs({ value, onChange, open, loading, now }: Props) {
  return (
    <div role="tablist" aria-label="Market duration" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {DURATIONS.map((d) => {
        const m = open.get(d)
        const active = d === value
        return (
          <button
            key={d}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(d)}
            className={cn('relative h-[92px] rounded-inner p-4 text-left transition-colors', active ? 'text-white' : 'bg-raised hover:bg-hover')}
          >
            {active && <motion.span layoutId="duration-fill" className="absolute inset-0 rounded-inner bg-brand" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
            <span className="relative block">
              <span className="block text-sm font-medium">{fmtDurationLong(d)}</span>
              {m ? (
                <>
                  <span className="num block text-2xl font-semibold">{fmtCountdown(Math.max(0, m.expiry - now / 1000))}</span>
                  <span className={cn('num block text-xs', active ? 'text-white/85' : 'text-dim')}>Strike {fmtStrike(m.strike)}</span>
                </>
              ) : loading ? (
                <Skeleton className="mt-2 h-8 w-24" />
              ) : (
                <span className={cn('block pt-2 text-sm', active ? 'text-white/85' : 'text-dim')}>Opens on your bet</span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
