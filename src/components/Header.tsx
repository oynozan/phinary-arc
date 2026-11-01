import { motion } from 'framer-motion'
import { ConnectKitButton } from 'connectkit'
import logoMark from '@/assets/logo-mark.svg'
import { BettorAvatar } from '@/components/BettorAvatar'
import { useAccount } from 'wagmi'
import { useUsdc } from '@/hooks/data'
import { fmtUsdc, shortAddr } from '@/lib/format'

export type Page = 'trade' | 'vault' | 'history'

const PAGES: { id: Page; label: string }[] = [
  { id: 'trade', label: 'Trade' },
  { id: 'vault', label: 'Vault' },
  { id: 'history', label: 'History' },
]

function Logo() {
  return (
    <span className="flex h-11 items-center gap-3">
      <img src={logoMark} alt="" className="h-9 w-auto" />
      <span className="text-base font-semibold">Phinary Arc</span>
    </span>
  )
}

function Wallet() {
  const { address } = useAccount()
  const { balance } = useUsdc(address)
  return (
    <ConnectKitButton.Custom>
      {({ isConnected, show, address: shown }) =>
        isConnected && shown ? (
          <>
            <button onClick={show} className="btn btn-secondary gap-3 pl-4 pr-2">
              <span className="num">{balance !== undefined ? `$${fmtUsdc(balance)}` : ''}</span>
              <span className="flex h-8 items-center gap-2 rounded-badge bg-card pl-1 pr-2">
                <BettorAvatar address={shown} size={24} />
                <span className="num text-sm font-medium">{shortAddr(shown)}</span>
              </span>
            </button>
          </>
        ) : (
          <button onClick={show} className="btn btn-primary">
            Connect wallet
          </button>
        )
      }
    </ConnectKitButton.Custom>
  )
}

export function Header({ page, onPage }: { page: Page; onPage: (p: Page) => void }) {
  return (
    <header className="mx-auto grid w-full max-w-7xl grid-cols-2 items-center gap-4 px-8 pb-6 pt-8 md:grid-cols-[1fr_auto_1fr]">
      <div className="justify-self-start">
        <Logo />
      </div>
      <nav role="tablist" aria-label="Pages" className="seg order-last col-span-2 w-full md:order-none md:col-span-1 md:w-auto">
        {PAGES.map((p) => (
          <button key={p.id} role="tab" aria-selected={page === p.id} onClick={() => onPage(p.id)} className="seg-item flex-1 md:flex-none">
            {page === p.id && <motion.span layoutId="nav-thumb" className="absolute inset-0 rounded-control bg-brand" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
            <span className="relative">{p.label}</span>
          </button>
        ))}
      </nav>
      <div className="flex items-center gap-3 justify-self-end">
        <Wallet />
      </div>
    </header>
  )
}
