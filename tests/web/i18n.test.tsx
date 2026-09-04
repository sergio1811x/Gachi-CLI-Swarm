// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { AppProviders } from '../../web/src/AppProviders.js'
import { Topbar } from '../../web/src/layout/Topbar.js'
import { UI_LANGUAGE_STORAGE_KEY } from '../../web/src/uiLanguage.js'
import { WelcomePane } from '../../web/src/worker/WelcomePane.js'

const versionInfo = {
  currentVersion: '0.6.0-alpha.5',
  installHint: 'npm install -g @tt-a1i/gachi-cli-swarm@latest',
  latestVersion: '0.6.0-alpha.5',
  packageName: '@tt-a1i/gachi-cli-swarm',
  releaseUrl: 'https://www.npmjs.com/package/@tt-a1i/gachi-cli-swarm',
  updateAvailable: false,
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

const switchToChinese = () => {
  fireEvent.click(screen.getByTestId('topbar-settings'))
  const select = screen.getByLabelText('Language') as HTMLSelectElement
  fireEvent.change(select, { target: { value: 'zh' } })
  // Language applies live inside the open dialog; assert it, then close so
  // the shell behind the overlay becomes accessible to role queries again.
  expect(screen.getByLabelText('语言')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
}

describe('UI language switcher', () => {
  test('switches shell copy to Chinese and persists the choice', () => {
    render(
      <AppProviders>
        <Topbar version="0.6.0-alpha.5" versionInfo={versionInfo} />
        <WelcomePane onAddWorkspace={() => {}} />
      </AppProviders>
    )

    expect(screen.getByText('Welcome to Gachi CLI Swarm')).toBeInTheDocument()
    switchToChinese()

    expect(screen.getByText('欢迎使用 Gachi CLI Swarm')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /添加第一个 Workspace/ })).toBeInTheDocument()
    expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('zh')
  })

  test('still switches for the current session when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    render(
      <AppProviders>
        <Topbar version="0.6.0-alpha.5" versionInfo={versionInfo} />
        <WelcomePane onAddWorkspace={() => {}} />
      </AppProviders>
    )

    switchToChinese()

    expect(screen.getByText('欢迎使用 Gachi CLI Swarm')).toBeInTheDocument()
  })
})
