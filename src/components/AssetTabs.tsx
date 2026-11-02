import { motion } from 'framer-motion'
import TokenBTC from '@web3icons/react/icons/tokens/TokenBTC'
import TokenETH from '@web3icons/react/icons/tokens/TokenETH'
import TokenSOL from '@web3icons/react/icons/tokens/TokenSOL'
import { ASSETS, type AssetMeta } from '@/lib/contracts'
import { cn } from '@/lib/utils'

const ICONS: Partial<Record<AssetMeta['key'], typeof TokenBTC>> = { BTC: TokenBTC, ETH: TokenETH, SOL: TokenSOL }

/** Token logo, or for a stock (no logo in the icon set) a monogram in the same 20px circle. */
function AssetIcon({ asset }: { asset: AssetMeta }) {
  const Icon = ICONS[asset.key]
  if (Icon) return <Icon variant="branded" size={20} />
  return (
    <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white text-xs font-semibold text-canvas">
      {asset.key[0]}
    </span>
  )
}

/** Underline tabs. Deliberately a different shape from the page nav so the two never read as one control. */
export function AssetTabs({ value, onChange }: { value: AssetMeta; onChange: (a: AssetMeta) => void }) {
  return (
    <div role="tablist" aria-label="Asset" className="flex min-w-0 gap-6 overflow-x-auto">
      {ASSETS.map((a) => {
        const active = a.id === value.id
        return (
          <button
            key={a.id}
            role="tab"
            aria-selected={active}
            title={a.name}
            onClick={() => onChange(a)}
            className={cn('relative flex h-11 shrink-0 items-center gap-2 text-base font-medium transition-colors', active ? 'text-white' : 'text-dim hover:text-white')}
          >
            <AssetIcon asset={a} />
            {a.key}
            {active && <motion.span layoutId="asset-underline" className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-brand" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
          </button>
        )
      })}
    </div>
  )
}
