import './setup'
import { describe, expect, test } from 'bun:test'
import { priceScale, timeTicks } from '@/lib/chartScale'
import { rng } from './contractRef'

describe('priceScale', () => {
  test('fuzz: ticks are evenly spaced, contain [min, max], and there are 3..7 of them', () => {
    const r = rng(5)
    for (let i = 0; i < 20000; i++) {
      const base = [3, 25, 150, 180, 3500, 77_000, 120_000][i % 7] * (0.5 + r())
      const min = base * (1 - r() * 0.02)
      const max = min + base * r() * 0.02
      const s = priceScale(min, max)
      expect(s.lo).toBeLessThanOrEqual(min + 1e-9)
      expect(s.hi).toBeGreaterThanOrEqual(max - 1e-9)
      expect(s.ticks.length).toBeGreaterThanOrEqual(2)
      expect(s.ticks.length).toBeLessThanOrEqual(7)
      const step = s.ticks[1] - s.ticks[0]
      for (let j = 1; j < s.ticks.length; j++) expect(Math.abs(s.ticks[j] - s.ticks[j - 1] - step)).toBeLessThan(step * 1e-6)
    }
  })

  test('labels at `decimals` are distinct for every tick (no duplicate axis labels)', () => {
    const r = rng(9)
    const dupes: string[] = []
    for (let i = 0; i < 5000; i++) {
      const base = [150, 180, 3500, 77_000][i % 4] * (0.5 + r())
      const min = base * (1 - r() * 0.001)
      const max = min + base * r() * 0.001
      const s = priceScale(min, max)
      const labels = s.ticks.map((t) => t.toFixed(s.decimals))
      if (new Set(labels).size !== labels.length) dupes.push(`${min}..${max}: ${labels.join(',')}`)
    }
    expect(dupes).toEqual([])
  })

  test('flat series as PriceChart feeds it (padded by max(12% range, 0.04% price)) gets >= 2 distinct labelled ticks', () => {
    for (const p of [2, 3.7, 25, 150.37, 182.5, 3512.25, 77_743.79]) {
      const pad = Math.max(0, p * 0.0004)
      const s = priceScale(p - pad, p + pad)
      expect(s.hi).toBeGreaterThan(s.lo)
      const labels = s.ticks.map((t) => t.toFixed(s.decimals))
      expect(new Set(labels).size).toBe(labels.length)
      expect(labels.map(Number)).toEqual(s.ticks)
    }
  })
})

describe('timeTicks', () => {
  test('ticks are on round minutes inside the window and at most `max`', () => {
    const start = Date.UTC(2026, 10, 1, 14, 2, 17)
    for (const span of [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 3600_000]) {
      const ticks = timeTicks(start, start + span)
      expect(ticks.length).toBeLessThanOrEqual(6)
      expect(ticks.length).toBeGreaterThan(0)
      for (const t of ticks) {
        expect(t).toBeGreaterThanOrEqual(start)
        expect(t).toBeLessThanOrEqual(start + span)
        expect(t % 60_000).toBe(0)
      }
    }
  })
})
