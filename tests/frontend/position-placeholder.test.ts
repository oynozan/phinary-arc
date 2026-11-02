// usePosition (src/hooks/data.ts) builds its options with positionQueryOptions. They are run through
// react-query's own QueryObserver (what useQuery uses under the hood) to see what TradePage / PositionPanel
// receive when the selected market changes.
import '../unit/setup'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { USER } from './helpers/logs'
import { stubClient } from './helpers/stub'
import { positionQueryOptions } from '@/hooks/data'

const positions: Record<string, bigint[]> = { '10': [7_000_000n, 0n, 3_000_000n, 0n], '11': [0n, 0n, 0n, 0n] }
let release: (() => void) | undefined
let restore: () => void
beforeAll(() => {
  restore = stubClient({
    multicall: async ({ contracts }: { contracts: { args: unknown[] }[] }) => {
      const id = String(contracts[0].args[0])
      if (id === '11') await new Promise<void>((r) => (release = r))
      const order = { stopPrice: id === '10' ? 60_000n * 10n ** 18n : 0n, takeProfitPrice: 0n }
      return [positions[id], order, { stopPrice: 0n, takeProfitPrice: 0n }]
    },
  })
})
afterAll(() => restore())

test('regression: after the selected market changes, the previous market\'s position (and its stop loss) is not served as the new one\'s', async () => {
  const qc = new QueryClient()
  const obs = new QueryObserver(qc, positionQueryOptions(10n, USER) as never)
  const unsub = obs.subscribe(() => undefined)
  await qc.fetchQuery(positionQueryOptions(10n, USER) as never)
  expect((obs.getCurrentResult().data as { upUnits: bigint }).upUnits).toBe(7_000_000n)

  // The 15m market rolls over (or the user picks a duration with no open market).
  obs.setOptions(positionQueryOptions(11n, USER) as never)
  const whileLoading = obs.getCurrentResult()
  obs.setOptions(positionQueryOptions(undefined, USER) as never)
  const noMarket = obs.getCurrentResult()
  release?.()
  unsub()

  expect({
    market11Units: (whileLoading.data as { upUnits: bigint } | undefined)?.upUnits,
    noMarketStop: (noMarket.data as { upOrder: { stopPrice: bigint } } | undefined)?.upOrder.stopPrice,
  }).toEqual({ market11Units: undefined, noMarketStop: undefined })
})

test('refreshing the same market keeps its data while the refetch runs (no loading flicker)', async () => {
  const qc = new QueryClient()
  const opts = positionQueryOptions(10n, USER) as never
  const obs = new QueryObserver(qc, opts)
  const unsub = obs.subscribe(() => undefined)
  await qc.fetchQuery(opts)
  void qc.invalidateQueries({ queryKey: ['position'] })
  expect((obs.getCurrentResult().data as { upUnits: bigint }).upUnits).toBe(7_000_000n)
  unsub()
})
