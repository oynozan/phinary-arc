import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden className={cn('skeleton', className)} style={style} />
}
