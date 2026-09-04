import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Detects the machine-level HTTP(S) proxy so the Telegram client can reach
 * api.telegram.org the same way the user's browser does (common setup:
 * local HTTP proxy like http://127.0.0.1:10809 that console
 * programs ignore — audit follow-up after real-world "fetch failed").
 *
 * Resolution order (telegram-service): explicit `telegram_proxy_url` setting
 * wins; special value `off` disables; otherwise the system/env proxy is used.
 */

const exec = promisify(execFile)

const WIN_INET_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

export interface DetectedProxy {
  /** Ready-to-use proxy URL, or null when none detected/supported. */
  url: string | null
  source: 'none' | 'env' | 'windows-system' | 'unsupported-socks'
}

/** Normalizes a raw WinINET ProxyServer value into a usable URL. */
export const normalizeProxyServerValue = (raw: string): DetectedProxy => {
  const value = raw.trim()
  if (!value) return { url: null, source: 'none' }
  // Per-protocol form: "http=host:port;https=host:port;socks=host:port"
  const httpsEntry = /(?:^|;)https?=([^;\s]+)/i.exec(value)?.[1]
  const socksEntry = /(?:^|;)socks?=([^;\s]+)/i.exec(value)?.[1]
  if (socksEntry && !httpsEntry) {
    // undici's ProxyAgent speaks HTTP CONNECT only; SOCKS needs another agent.
    return { url: null, source: 'unsupported-socks' }
  }
  const target = httpsEntry ?? socksEntry ?? value
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    return { url: target, source: 'windows-system' }
  }
  return { url: `http://${target}`, source: 'windows-system' }
}

let cache: { at: number; result: DetectedProxy } | null = null
const CACHE_TTL_MS = 10 * 60_000

const readEnvProxy = (): DetectedProxy => {
  const url =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy
  return url ? { url, source: 'env' } : { url: null, source: 'none' }
}

export const clearSystemProxyCache = (): void => {
  cache = null
}

export const detectSystemProxy = async (): Promise<DetectedProxy> => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result

  let result: DetectedProxy
  if (process.platform !== 'win32') {
    result = readEnvProxy()
  } else {
    const env = readEnvProxy()
    try {
      const enableOut = await exec('reg.exe', ['query', WIN_INET_KEY, '/v', 'ProxyEnable'], {
        windowsHide: true,
        timeout: 3_000,
      })
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/.test(enableOut.stdout)
      if (!enabled) {
        result = env.url ? env : { url: null, source: 'none' }
      } else {
        const serverOut = await exec('reg.exe', ['query', WIN_INET_KEY, '/v', 'ProxyServer'], {
          windowsHide: true,
          timeout: 3_000,
        })
        const raw = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(serverOut.stdout)?.[1] ?? ''
        const normalized = normalizeProxyServerValue(raw)
        result = normalized.url ? normalized : normalized.source === 'none' ? env : normalized
      }
    } catch {
      result = env
    }
  }

  cache = { at: Date.now(), result }
  return result
}
