// Test helper: build raw RPC logs for the market ABI so parseEventLogs / getContractEvents decode them
// exactly as they would decode a real eth_getLogs response.
import '../../unit/setup'
import { encodeAbiParameters, encodeEventTopics, getAbiItem, type Address, type Hex, type Log } from 'viem'
import { marketAbi } from '../../../src/lib/abis'

export const MARKET = process.env.VITE_MARKET_ADDRESS as Address
export const USER = '0x1111111111111111111111111111111111111111' as Address
export const OTHER = '0x2222222222222222222222222222222222222222' as Address

let txCounter = 1
export const tx = () => `0x${(txCounter++).toString(16).padStart(64, '0')}` as Hex

export function marketLog(eventName: string, args: Record<string, unknown>, at: { block: bigint; logIndex: number; tx: Hex; address?: Address }): Log {
  const item = getAbiItem({ abi: marketAbi, name: eventName as never }) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] }
  const indexedArgs: Record<string, unknown> = {}
  for (const i of item.inputs) if (i.indexed) indexedArgs[i.name] = args[i.name]
  const topics = encodeEventTopics({ abi: marketAbi, eventName: eventName as never, args: indexedArgs as never })
  const data = encodeAbiParameters(
    item.inputs.filter((i) => !i.indexed) as never,
    item.inputs.filter((i) => !i.indexed).map((i) => args[i.name]) as never,
  )
  return {
    address: at.address ?? MARKET,
    blockHash: `0x${'ab'.repeat(32)}` as Hex,
    blockNumber: at.block,
    data,
    logIndex: at.logIndex,
    removed: false,
    topics: topics as [Hex, ...Hex[]],
    transactionHash: at.tx,
    transactionIndex: 0,
  } as Log
}
