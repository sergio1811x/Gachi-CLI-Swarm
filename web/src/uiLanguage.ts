export type UiLanguage =
  | 'en'
  | 'ru'
  | 'zh'
  | 'es'
  | 'pt'
  | 'fr'
  | 'it'
  | 'de'
  | 'ja'
  | 'ko'
  | 'ar'
  | 'hi'
  | 'tr'

export const UI_LANGUAGE_STORAGE_KEY = 'gachi.uiLanguage'

const UI_LANGUAGES: readonly UiLanguage[] = [
  'en',
  'ru',
  'zh',
  'es',
  'pt',
  'fr',
  'it',
  'de',
  'ja',
  'ko',
  'ar',
  'hi',
  'tr',
]

export const isUiLanguage = (value: string | null): value is UiLanguage =>
  value !== null && (UI_LANGUAGES as readonly string[]).includes(value)
