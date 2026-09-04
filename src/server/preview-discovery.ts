import { request } from 'node:http'

/**
 * Dev-server preview discovery (roadmap Wave 2, competitor QA-parity):
 * probe candidate localhost ports from the RUNTIME (same host as the PTY
 * workers) and report which respond over HTTP. The UI opens the winner in
 * the user's browser — iframes of third-party dev servers fight CSP/XFO,
 * so we don't embed.
 */

export interface PreviewCandidate {
  port: number
  status: number | null
  title: string | null
}

export type PreviewProber = (
  port: number,
  timeoutMs: number
) => Promise<{ status: number | null; title: string | null }>

export const DEFAULT_PREVIEW_PORTS = [3000, 5173, 4173, 8080, 8000, 4200, 1420]

const fetchProbe = async (
  port: number,
  timeoutMs: number
): Promise<{ status: number | null; title: string | null }> =>
  new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: timeoutMs },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        const timer = setTimeout(() => {
          res.destroy()
          resolve({ status: res.statusCode ?? null, title: null })
        }, timeoutMs)
        res.on('data', (chunk: string) => {
          body += chunk
          if (body.length > 64_000) {
            clearTimeout(timer)
            res.destroy()
            resolve({ status: res.statusCode ?? null, title: extractTitle(body) })
          }
        })
        res.on('end', () => {
          clearTimeout(timer)
          resolve({ status: res.statusCode ?? null, title: extractTitle(body) })
        })
        res.on('error', () => resolve({ status: res.statusCode ?? null, title: null }))
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: null, title: null })
    })
    req.on('error', () => resolve({ status: null, title: null }))
    req.end()
  })

const extractTitle = (html: string): string | null => {
  const match = /<title[^>]*>([^<]{0,120})<\/title>/i.exec(html)
  return match ? match[1]?.trim() || null : null
}

/** Probes the preferred port first (if any), then the defaults. Alive-only result. */
export const discoverPreviewServers = async (
  options: {
    ports?: number[] | undefined
    preferred?: number[] | undefined
    timeoutMs?: number | undefined
  } = {}
): Promise<PreviewCandidate[]> => {
  const timeoutMs = options.timeoutMs ?? 400
  const prober: PreviewProber = fetchProbe

  // Preferred ports go first and are re-probed even if they overlap defaults.
  const ordered: number[] = []
  for (const p of [...(options.preferred ?? []), ...(options.ports ?? DEFAULT_PREVIEW_PORTS)]) {
    if (!ordered.includes(p)) ordered.push(p)
  }

  const results = await Promise.all(
    ordered.map(async (port): Promise<PreviewCandidate | null> => {
      const { status, title } = await prober(port, timeoutMs)
      if (status === null) return null
      return { port, status, title }
    })
  )
  return results.filter((r): r is PreviewCandidate => r !== null)
}
