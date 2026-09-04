import { describe, expect, test } from 'vitest'

import {
  clearSystemProxyCache,
  detectSystemProxy,
  normalizeProxyServerValue,
} from '../../src/server/system-proxy.js'
import { createTelegramBotApi } from '../../src/server/telegram-bot-api.js'

describe('system proxy detection', () => {
  test('normalizes WinINET ProxyServer forms into usable URLs', () => {
    expect(normalizeProxyServerValue('127.0.0.1:10809')).toEqual({
      source: 'windows-system',
      url: 'http://127.0.0.1:10809',
    })
    expect(normalizeProxyServerValue('http://127.0.0.1:10809')).toEqual({
      source: 'windows-system',
      url: 'http://127.0.0.1:10809',
    })
    expect(normalizeProxyServerValue('localhost=8080;https=proxy.corp.local:3128')).toEqual({
      source: 'windows-system',
      url: 'http://proxy.corp.local:3128',
    })
  })

  test('socks-only entries are reported as unsupported instead of guessing', () => {
    const result = normalizeProxyServerValue('socks=127.0.0.1:10808')
    expect(result.url).toBeNull()
    expect(result.source).toBe('unsupported-socks')
  })

  test('empty value means no proxy', () => {
    expect(normalizeProxyServerValue('   ')).toEqual({ source: 'none', url: null })
  })

  test('detect returns a shaped result without throwing (win32 registry or env)', async () => {
    clearSystemProxyCache()
    const result = await detectSystemProxy()
    expect(['none', 'env', 'windows-system', 'unsupported-socks']).toContain(result.source)
    if (result.url) expect(result.url).toMatch(/^[a-z][a-z0-9+.-]*:\/\//i)
  })
})

describe('telegram bot api network errors', () => {
  test('network failures explain themselves instead of bare "fetch failed"', async () => {
    // Port 9 (discard) on loopback refuses connections deterministically.
    const api = createTelegramBotApi({ token: '123:test-token', apiRoot: 'http://127.0.0.1:9' })
    await expect(api.getMe()).rejects.toThrow(/check internet\/VPN\/proxy access/)
  }, 20_000)
})
