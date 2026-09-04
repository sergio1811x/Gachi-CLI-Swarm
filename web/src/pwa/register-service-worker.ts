// Service worker registration with an update-available notification channel.
//
// Producers: registerServiceWorkerWithEnv (called once at boot).
// Consumers: subscribeServiceWorkerUpdate (the UpdateAvailableToast component).
// The split lets us inject a fake env in unit tests instead of leaning on
// jsdom's missing ServiceWorker implementation or import.meta.env stubbing.

import { silentReload } from '../useBeforeUnloadGuard.js'

export type ServiceWorkerUpdateApply = () => void
type ServiceWorkerUpdateListener = (apply: ServiceWorkerUpdateApply | null) => void

const listeners = new Set<ServiceWorkerUpdateListener>()
let currentApply: ServiceWorkerUpdateApply | null = null

const setUpdateApply = (apply: ServiceWorkerUpdateApply | null) => {
  currentApply = apply
  for (const listener of listeners) listener(apply)
}

export const subscribeServiceWorkerUpdate = (
  listener: ServiceWorkerUpdateListener
): (() => void) => {
  listeners.add(listener)
  listener(currentApply)
  return () => {
    listeners.delete(listener)
  }
}

// Exposed only for tests to clear the module-level singleton between cases.
export const __resetServiceWorkerUpdateStateForTests = (): void => {
  listeners.clear()
  currentApply = null
}

// Exposed only for component tests that want to drive the update state without
// spinning up the full SW lifecycle (which jsdom doesn't model). Production
// code never touches this; it goes through registerServiceWorkerWithEnv.
export const __setServiceWorkerUpdateForTests = (apply: ServiceWorkerUpdateApply | null): void => {
  setUpdateApply(apply)
}

export interface ServiceWorkerEnv {
  isProd: boolean
  serviceWorker: ServiceWorkerContainer | null
  // Production callers should inject silentReload here so the guard skips the
  // SW-triggered reload; tests may inject a plain spy.
  reload: () => void
}

const CONTROLLERCHANGE_FALLBACK_MS = 2000

export const registerServiceWorkerWithEnv = async (env: ServiceWorkerEnv): Promise<void> => {
  if (!env.serviceWorker) return
  if (!env.isProd) {
    // Dev mode: clear any prod SW that previously registered on the same
    // origin/port so HMR isn't intercepted by a stale cache.
    const registrations = await env.serviceWorker.getRegistrations()
    await Promise.all(registrations.map((registration) => registration.unregister()))
    return
  }

  let registration: ServiceWorkerRegistration
  try {
    registration = await env.serviceWorker.register('/sw.js')
  } catch {
    // Swallow registration errors — failing to set up the SW should never
    // prevent the app from booting.
    return
  }

  const observe = (worker: ServiceWorker) => {
    const onStateChange = () => {
      if (worker.state === 'installed' && env.serviceWorker?.controller) {
        // A previous SW is still controlling this page and the new one is
        // ready: this is the update-available signal.
        setUpdateApply(() => {
          worker.postMessage({ type: 'SKIP_WAITING' })
          // Belt and braces: if controllerchange doesn't reach us within a
          // couple seconds, reload anyway so the user is never stuck.
          setTimeout(env.reload, CONTROLLERCHANGE_FALLBACK_MS)
        })
      }
    }
    worker.addEventListener('statechange', onStateChange)
  }

  if (registration.waiting && env.serviceWorker.controller) observe(registration.waiting)
  if (registration.installing) observe(registration.installing)
  registration.addEventListener('updatefound', () => {
    if (registration.installing) observe(registration.installing)
  })

  let refreshing = false
  env.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return
    refreshing = true
    env.reload()
  })
}

export const registerServiceWorker = (): Promise<void> => {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return Promise.resolve()
  return registerServiceWorkerWithEnv({
    isProd: import.meta.env.PROD,
    serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : null,
    reload: silentReload,
  })
}
