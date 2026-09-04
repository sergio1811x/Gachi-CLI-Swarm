import { useCallback, useEffect, useState } from 'react'

export type UiTheme = 'dark' | 'light'

const THEME_STORAGE_KEY = 'gachi.theme'

const isUiTheme = (value: string | null): value is UiTheme => value === 'dark' || value === 'light'

const readStoredTheme = (): UiTheme => {
  if (typeof window === 'undefined') return 'dark'
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return isUiTheme(stored) ? stored : 'dark'
}

const applyTheme = (theme: UiTheme) => {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
}

export const useTheme = (): { theme: UiTheme; setTheme: (theme: UiTheme) => void } => {
  const [theme, setThemeState] = useState<UiTheme>(readStoredTheme)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const setTheme = useCallback((next: UiTheme) => {
    setThemeState(next)
    window.localStorage.setItem(THEME_STORAGE_KEY, next)
  }, [])

  return { theme, setTheme }
}
