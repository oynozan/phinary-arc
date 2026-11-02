// Test helper: replace methods on the app's real viem client (src/lib/realtime.ts) instead of mocking the
// module. `bun test` runs every file in one process and module mocks leak between files; these stubs are
// put back with the returned restore function.
import '../../unit/setup'
import { wsClient } from '@/lib/realtime'

type Methods = Record<string, unknown>

export function stubClient(methods: Methods, target: Methods = wsClient as unknown as Methods): () => void {
  const saved = Object.fromEntries(Object.keys(methods).map((k) => [k, target[k]]))
  Object.assign(target, methods)
  return () => Object.assign(target, saved)
}

/** Stub on the client's transport (getRpcClient). */
export const stubTransport = (methods: Methods) => stubClient(methods, wsClient.transport as unknown as Methods)
