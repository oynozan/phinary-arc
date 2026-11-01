import { useEffect, useRef, useState } from 'react'
import { fmtPrice } from '@/lib/format'

/** Eases toward the live value. Only moves when real data changes. */
export function AnimatedPrice({ value, className }: { value: number | undefined; className?: string }) {
  const [display, setDisplay] = useState(value ?? 0)
  const current = useRef(value ?? 0)

  useEffect(() => {
    if (value === undefined) return
    let raf = 0
    const tick = () => {
      current.current += (value - current.current) * 0.18
      if (Math.abs(value - current.current) < value * 1e-7) current.current = value
      setDisplay(current.current)
      if (current.current !== value) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])

  if (value === undefined) return <span className={className}>--</span>
  return <span className={className}>{fmtPrice(display)}</span>
}
