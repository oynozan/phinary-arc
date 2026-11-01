import { motion } from 'framer-motion'
import TokenBTC from '@web3icons/react/icons/tokens/TokenBTC'
import TokenETH from '@web3icons/react/icons/tokens/TokenETH'
import TokenSOL from '@web3icons/react/icons/tokens/TokenSOL'
import { ASSETS, type AssetMeta } from '@/lib/contracts'
import { cn } from '@/lib/utils'

const ICONS = { BTC: TokenBTC, ETH: TokenETH, SOL: TokenSOL } as const

/** Underline tabs. Deliberately a different shape from the page nav so the two never read as one control. */
export function AssetTabs({ value, onChange }: { value: AssetMeta; onChange: (a: AssetMeta) => void }) {
  return (
    <div role="tablist" aria-label="Asset" className="flex gap-6">
      {ASSETS.map((a) => {
        const Icon = ICONS[a.key]
        const active = a.id === value.id
        return (
          <button
            key={a.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(a)}
            className={cn('relative flex h-11 items-center gap-2 text-base font-medium transition-colors', active ? 'text-white' : 'text-dim hover:text-white')}
          >
            <Icon variant="branded" size={20} />
            {a.key}
            {active && <motion.span layoutId="asset-underline" className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-brand" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
          </button>
        )
      })}
    </div>
  )
}
