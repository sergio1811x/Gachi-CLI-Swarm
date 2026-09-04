// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  NOTIFICATION_SETTINGS_KEY,
  NotificationProvider,
  useNotifications,
} from '../../web/src/notifications/NotificationProvider.js'
import { NotificationSettingsButton } from '../../web/src/notifications/NotificationSettingsButton.js'
import { Toaster } from '../../web/src/ui/toast.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'

const notifications: Array<{ body: string | undefined; title: string }> = []
const playedAudioSources: string[] = []
let storage = new Map<string, string>()

const installLocalStorage = () => {
  storage = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  })
}

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>()

  constructor(title: string, options?: NotificationOptions) {
    notifications.push({ body: options?.body, title })
  }
}

class FakeAudio {
  preload = ''
  volume = 1

  constructor(readonly src: string) {}

  addEventListener() {}

  pause() {}

  play() {
    playedAudioSources.push(this.src)
    return Promise.resolve()
  }
}

const wrap = (children: ReactNode) => (
  <ToastProvider>
    <NotificationProvider>
      {children}
      <Toaster />
    </NotificationProvider>
  </ToastProvider>
)

const PushNotification = () => {
  const { notify } = useNotifications()
  return (
    <button
      type="button"
      data-testid="notify"
      onClick={() =>
        notify({
          brief: 'ember-check-23 reported',
          detail: 'ember-check-23 reported in mco; 0 queued task(s) remain.',
          kind: 'success',
          title: 'Member report',
        })
      }
    >
      notify
    </button>
  )
}

const readSavedSettings = (): Record<string, unknown> =>
  JSON.parse(window.localStorage.getItem(NOTIFICATION_SETTINGS_KEY) ?? '{}')

beforeEach(() => {
  installLocalStorage()
  notifications.length = 0
  FakeNotification.permission = 'default'
  FakeNotification.requestPermission.mockClear()
  FakeNotification.requestPermission.mockImplementation(async () => {
    FakeNotification.permission = 'granted'
    return 'granted'
  })
  playedAudioSources.length = 0
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: FakeNotification,
  })
  Object.defineProperty(window, 'Audio', {
    configurable: true,
    value: FakeAudio,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ token: '7c0a5925-06ed-4dae-8a8a-0000000062b3' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        })
    )
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('notification settings', () => {
  test('keeps edits as a draft and persists only after saving', async () => {
    render(wrap(<NotificationSettingsButton />))

    fireEvent.click(screen.getByTestId('topbar-settings'))
    const group = screen.getByRole('radiogroup', { name: 'Sound notifications' })
    expect(group).toBeInTheDocument()
    // Provider defaults are persisted on mount.
    expect(readSavedSettings().sound).toBe('sound1')

    fireEvent.click(screen.getByRole('radio', { name: /Sound 2/ }))
    fireEvent.click(screen.getByRole('radio', { name: /Detailed/ }))

    // Draft state: nothing persisted until the user saves.
    expect(readSavedSettings().sound).toBe('sound1')
    expect(screen.getByTestId('settings-save')).toBeEnabled()

    fireEvent.click(screen.getByTestId('settings-save'))

    await waitFor(() => expect(readSavedSettings().sound).toBe('sound2'))
    expect(readSavedSettings().detail).toBe('detailed')
    // Dialog closes after a successful save.
    await waitFor(() =>
      expect(screen.queryByTestId('notification-settings')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('toast')).toHaveTextContent('Settings saved')
  })

  test('save stays disabled until something changed, cancel discards the draft', () => {
    render(wrap(<NotificationSettingsButton />))

    fireEvent.click(screen.getByTestId('topbar-settings'))
    const save = screen.getByTestId('settings-save')
    expect(save).toBeDisabled()

    fireEvent.click(screen.getByRole('radio', { name: /Sound 3/ }))
    expect(save).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('notification-settings')).not.toBeInTheDocument()
    expect(readSavedSettings().sound).toBe('sound1')
  })

  test('previews a sound without selecting it', () => {
    render(wrap(<NotificationSettingsButton />))

    fireEvent.click(screen.getByTestId('topbar-settings'))
    fireEvent.click(screen.getByRole('button', { name: 'Preview Sound 2 sound' }))

    expect(readSavedSettings().sound).toBe('sound1')
    expect(playedAudioSources).toEqual(['/sounds/gachi-sound-2.mp3'])
  })

  test('uses detailed copy, selected sound, and browser notification when enabled and saved', async () => {
    render(
      wrap(
        <>
          <NotificationSettingsButton />
          <PushNotification />
        </>
      )
    )

    fireEvent.click(screen.getByTestId('topbar-settings'))
    fireEvent.click(screen.getByRole('radio', { name: /Sound 1/ }))
    fireEvent.click(screen.getByRole('radio', { name: /Detailed/ }))
    fireEvent.click(screen.getByLabelText('Browser notifications'))

    await waitFor(() => expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() =>
      expect(screen.queryByTestId('notification-settings')).not.toBeInTheDocument()
    )

    fireEvent.click(screen.getByTestId('notify'))

    // The "Settings saved" toast from the save step is still on screen, so
    // match the report toast by content instead of testid uniqueness.
    const toasts = await screen.findAllByTestId('toast')
    expect(toasts.map((node) => node.textContent)).toContain(
      'ember-check-23 reported in mco; 0 queued task(s) remain.'
    )
    expect(notifications).toEqual([
      {
        body: 'ember-check-23 reported in mco; 0 queued task(s) remain.',
        title: 'Member report',
      },
    ])
    expect(playedAudioSources).toEqual(['/sounds/gachi-sound-1.mp3'])
  })

  test('regenerating the session key confirms first and swaps the token', async () => {
    render(wrap(<NotificationSettingsButton />))

    fireEvent.click(screen.getByTestId('topbar-settings'))
    await waitFor(() =>
      expect(screen.getByTestId('session-token-value')).toHaveTextContent(/7c0a5925…62b3/)
    )

    fireEvent.click(screen.getByTestId('session-token-regenerate'))
    // Confirmation dialog explains the impact before anything happens.
    expect(screen.getByTestId('confirm-description')).toHaveTextContent(
      'Other open tabs will be signed out'
    )

    fireEvent.click(screen.getByTestId('confirm-action'))
    await waitFor(() => expect(screen.getByTestId('session-token-value')).toBeInTheDocument())
  })
})
