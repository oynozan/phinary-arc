import { useState, type ComponentProps } from 'react'
import { motion } from 'framer-motion'
import { BuyForm } from '@/components/BuyForm'
import { PositionPanel } from '@/components/PositionPanel'
import type { Market, Quote } from '@/lib/contracts'

type BuyProps = ComponentProps<typeof BuyForm>

interface Props extends BuyProps {
  /** quote for the market's own strike, used to value and sell an existing position */
  marketQuote: Quote | undefined
}

export function TradePanel({ marketQuote, ...buy }: Props) {
  const [tab, setTab] = useState<'buy' | 'sell'>('buy')
  const market: Market | undefined = buy.market

  return (
    <div className="card flex h-full flex-col gap-6">
      <div role="tablist" aria-label="Trade" className="seg w-full">
        {(['buy', 'sell'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className="seg-item flex-1">
            {tab === t && <motion.span layoutId="trade-thumb" className="absolute inset-0 rounded-control bg-brand" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
            <span className="relative">{t === 'buy' ? 'Buy' : 'Sell'}</span>
          </button>
        ))}
      </div>

      {tab === 'buy' && <BuyForm {...buy} />}
      {tab === 'sell' && (market ? <PositionPanel market={market} quote={marketQuote} /> : <p className="text-sm text-dim">No open market to sell in.</p>)}
    </div>
  )
}
