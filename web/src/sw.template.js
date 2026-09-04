// Gachi CLI Swarm PWA service worker.
//
// The single occurrence of the build-time version placeholder lives in the
// VERSION constant directly below. `web/src/pwa/build-sw.ts` rewrites it at
// `vite build` time so each Gachi CLI Swarm release writes to its own cache bucket. Old
// caches are kept intentionally — a tab still controlled by a previous SW
// generation must be able to resolve its lazy-loaded hashed chunks, and
// storage growth is bounded by Gachi CLI Swarm's release cadence.

const VERSION = '__GACHI_VERSION__'
const SHELL_CACHE = `gachi-cache-v${VERSION}-shell`
const ASSETS_CACHE = `gachi-cache-v${VERSION}-assets`
const STATIC_CACHE = `gachi-cache-v${VERSION}-static`

const SHELL_PRECACHE = ['/']
const STATIC_PRECACHE = [
  '/logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon-180.png',
  '/icons/icon-32.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_PRECACHE)),
      caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_PRECACHE)),
      caches.open(ASSETS_CACHE),
    ])
  )
})

self.addEventListener('activate', (event) => {
  // No cache cleanup on activate. Prior-version caches stay so tabs that were
  // loaded under an older SW (and didn't reload yet) can still resolve their
  // lazily-imported xterm/webgl chunks. Browser GC reclaims at quota.
  event.waitUntil(Promise.resolve())
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

const isHashedAsset = (pathname) => pathname.startsWith('/assets/')
const isStaticAsset = (pathname) =>
  pathname.startsWith('/icons/') ||
  pathname.startsWith('/screenshots/') ||
  pathname.startsWith('/cli-icons/') ||
  pathname.startsWith('/sounds/') ||
  pathname === '/logo.png'
const isShell = (pathname) => pathname === '/' || pathname === '/index.html'

const cacheFirst = async (request, cacheName) => {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) cache.put(request, response.clone())
  return response
}

const networkFirst = async (request, cacheName) => {
  const cache = await caches.open(cacheName)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone())
    return response
  } catch (error) {
    const cached = await cache.match(request)
    if (cached) return cached
    throw error
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (event.request.method !== 'GET') return
  if (url.pathname.startsWith('/api/')) return
  if (url.pathname.startsWith('/ws/')) return
  if (url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest') return
  if (isShell(url.pathname)) {
    event.respondWith(networkFirst(event.request, SHELL_CACHE))
    return
  }
  if (isHashedAsset(url.pathname)) {
    event.respondWith(cacheFirst(event.request, ASSETS_CACHE))
    return
  }
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(event.request, STATIC_CACHE))
    return
  }
  event.respondWith(networkFirst(event.request, SHELL_CACHE))
})
