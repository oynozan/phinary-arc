/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'
import { CHAIN, RPC_HTTP } from './lib/network'
import { registerChain } from './tracing'

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(CHAIN.id, RPC_HTTP)

export const config = createConfig({
  chains: [CHAIN, mainnet], // mainnet needed for ENS resolution
  connectors: [injected()],
  transports: {
    // Batch concurrent reads into one HTTP request to stay under the public RPC rate limit.
    [CHAIN.id]: http(RPC_HTTP, { batch: { wait: 25 } }),
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})
