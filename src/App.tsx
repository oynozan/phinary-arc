import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Header, type Page } from '@/components/Header'
import { HistoryPage } from '@/components/HistoryPage'
import { TradePage } from '@/components/TradePage'
import { VaultPanel } from '@/components/VaultPanel'
import { useRealtimeSync } from '@/hooks/useRealtimeSync'
import { ASSETS, type AssetMeta } from '@/lib/contracts'

export default function App() {
  useRealtimeSync()
  const [page, setPage] = useState<Page>('trade')
  const [asset, setAsset] = useState<AssetMeta>(ASSETS[0])
  const [duration, setDuration] = useState(900)

  return (
    <div className="min-h-dvh">
      <Header page={page} onPage={setPage} />
      <main className="mx-auto w-full max-w-7xl px-8 pb-8">
        <AnimatePresence mode="wait">
          <motion.div key={page} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 34 }}>
            {page === 'trade' && <TradePage asset={asset} onAsset={setAsset} duration={duration} onDuration={setDuration} />}
            {page === 'vault' && <VaultPanel />}
            {page === 'history' && <HistoryPage />}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  )
}
