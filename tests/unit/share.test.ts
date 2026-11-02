import './setup'
import { afterAll, describe, expect, test } from 'bun:test'

// share.ts touches `window` lazily; provide a top-level (non-framed) window before importing it.
// All test files share one process, so the globals are removed again afterwards.
const g = globalThis as unknown as { window: unknown; document: unknown }
afterAll(() => {
  delete g.window
  delete g.document
})
const fakeWindow = { location: { origin: 'https://app.example' } } as { self?: unknown; top?: unknown; location: { origin: string } }
fakeWindow.self = fakeWindow
fakeWindow.top = fakeWindow
g.window = fakeWindow
g.document = { referrer: '' }

const { buildShareLink, getShareBase, installShareSync, parentStudioOrigins } = await import('@/lib/share')

describe('parentStudioOrigins', () => {
  test('uses a known ancestor or referrer origin, else both studio origins', () => {
    expect(parentStudioOrigins(['https://studio.arc.io'])).toEqual(['https://studio.arc.io'])
    expect(parentStudioOrigins(undefined, 'https://studio-staging.arc.io/x/y')).toEqual(['https://studio-staging.arc.io'])
    expect(parentStudioOrigins(['https://evil.example'], 'https://evil.example/')).toEqual(['https://studio.arc.io', 'https://studio-staging.arc.io'])
    expect(parentStudioOrigins(undefined, 'not a url')).toEqual(['https://studio.arc.io', 'https://studio-staging.arc.io'])
  })
})

describe('buildShareLink (top-level window)', () => {
  test('base is the app origin', async () => {
    expect(await getShareBase()).toBe('https://app.example')
  })
  test('encodes unsafe path chars, keeps query and fragment verbatim', async () => {
    expect(await buildShareLink('/trade/BTC')).toBe('https://app.example/trade/BTC')
    expect(await buildShareLink('trade')).toBe('https://app.example/trade')
    expect(await buildShareLink('/a b/ç')).toBe('https://app.example/a%20b/%C3%A7')
    expect(await buildShareLink('/x%zz/%20')).toBe('https://app.example/x%25zz/%20')
    expect(await buildShareLink('/claim?x=1 2#secret')).toBe('https://app.example/claim?x=1 2#secret')
    expect(await buildShareLink('/\\evil.com')).toBe('https://app.example/%5Cevil.com')
  })
  test('rejects absolute and protocol-relative URLs', async () => {
    await expect(buildShareLink('https://evil.com/x')).rejects.toThrow(TypeError)
    await expect(buildShareLink('//evil.com/x')).rejects.toThrow(TypeError)
    await expect(buildShareLink('javascript:alert(1)')).rejects.toThrow(TypeError)
  })
})

describe('installShareSync (framed)', () => {
  test('posts the initial route, then one debounced message per navigation, only to studio origins', async () => {
    const posted: Array<{ msg: unknown; origin: string }> = []
    const location = { pathname: '/trade', search: '?d=300', ancestorOrigins: ['https://studio.arc.io'] }
    let popstate: (() => void) | undefined
    const history = {
      pushState(_d: unknown, _u: string, url?: string | URL | null) { location.pathname = String(url) },
      replaceState(_d: unknown, _u: string, url?: string | URL | null) { location.pathname = String(url) },
    }
    const env = {
      self: {}, top: {},
      parent: { postMessage: (msg: unknown, origin: string) => posted.push({ msg, origin }) },
      location, referrer: '', history,
      addEventListener: (_t: 'popstate', l: () => void) => { popstate = l },
    }
    installShareSync(env)
    expect(posted).toEqual([{ msg: { type: 'arc-share:navigated', path: '/trade', search: '?d=300' }, origin: 'https://studio.arc.io' }])
    env.history.pushState(null, '', '/history')
    env.history.replaceState(null, '', '/vault')
    await new Promise((r) => setTimeout(r, 150))
    expect(posted.length).toBe(2)
    expect(posted[1].msg).toEqual({ type: 'arc-share:navigated', path: '/vault', search: '?d=300' })
    popstate?.()
    await new Promise((r) => setTimeout(r, 150))
    expect(posted.length).toBe(2) // unchanged route is not re-posted
    // second install is a no-op
    installShareSync(env)
    expect(posted.length).toBe(2)
  })
})
