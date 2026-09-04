import { useEffect } from 'react'

// One-shot opt-out: when set, the next beforeunload skips the prompt and the
// flag clears. Lets background flows (service-worker auto-reload, runtime-
// offline auto-recovery) bypass the always-on guard without globally
// disabling it.
let silentUnloadOnce = false

export const allowNextUnloadSilently = (): void => {
  silentUnloadOnce = true
}

// Single entry point for all programmatic page reloads while the guard might
// be active. Arms the silent flag and triggers the reload atomically so
// callers can't forget the two-step. Use this instead of
// window.location.reload() anywhere an auto-reload should not surface the
// close-confirmation dialog.
export const silentReload = (): void => {
  silentUnloadOnce = true
  window.location.reload()
}

export const __resetBeforeUnloadGuardForTests = (): void => {
  silentUnloadOnce = false
}

export const useBeforeUnloadGuard = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled) return

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (silentUnloadOnce) {
        silentUnloadOnce = false
        return
      }
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [enabled])
}
