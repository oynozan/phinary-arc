import type { ReactNode } from 'react'
import { CircleHelp } from 'lucide-react'
import { cn } from '@/lib/utils'

/** A "?" icon that explains something on hover or keyboard focus. Use this instead of captions. */
export function HelpTip({ children, align = 'center', className }: { children: ReactNode; align?: 'center' | 'end' | 'start'; className?: string }) {
  return (
    <span className={cn('group relative inline-flex align-middle', className)}>
      <button type="button" aria-label="More info" className="inline-flex h-5 w-5 items-center justify-center rounded-full text-dim outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-brand">
        <CircleHelp size={16} />
      </button>
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute bottom-full z-30 mb-2 w-64 rounded-inner bg-hover p-3 text-sm font-normal text-white opacity-0 shadow-xl transition-opacity group-focus-within:opacity-100 group-hover:opacity-100',
          align === 'center' && 'left-1/2 -translate-x-1/2',
          align === 'end' && 'right-0',
          align === 'start' && 'left-0',
        )}
      >
        {children}
      </span>
    </span>
  )
}
