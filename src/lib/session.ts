import { useSyncExternalStore } from 'react'

/**
 * Markets where this browser session saw the user hold an open position. They stay in the
 * Positions table after they end (so the outcome shows up live) and disappear on reload.
 */
const tracked = new Set<string>()
const listeners = new Set<() => void>()
let snapshot: ReadonlySet<string> = new Set()

export function trackMarket(id: bigint): void {
  const key = String(id)
  if (tracked.has(key)) return
  tracked.add(key)
  snapshot = new Set(tracked)
  listeners.forEach((l) => l())
}

export const isTracked = (id: bigint) => tracked.has(String(id))

export function useTrackedMarkets(): ReadonlySet<string> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => snapshot,
  )
}
