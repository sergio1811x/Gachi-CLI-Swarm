import type { ReactNode } from 'react'

import { NotificationSettingsButton } from '../notifications/NotificationSettingsButton.js'
import { SubscriptionLimitsButton } from '../subscriptions/SubscriptionLimitsButton.js'
import { TelegramSettingsButton } from '../telegram/TelegramSettingsButton.js'
import { AiEnvironmentPanel } from '../worker/AiEnvironmentPanel.js'

type TopbarProps = {
  actions?: ReactNode
  hideActions?: boolean
  onToggleTaskGraph?: () => void
  openTaskCount?: number
  taskGraphOpen?: boolean
}

export const Topbar = ({ actions, hideActions = false }: TopbarProps) => {
  return (
    <header
      className="flex h-11 shrink-0 items-center px-4"
      style={{
        background: 'var(--bg-0)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div className="flex items-center gap-2">
        <img
          src="/logo.jpg"
          alt=""
          aria-hidden
          className="h-7 w-11 rounded-sm"
          data-testid="topbar-logo"
        />
        <span className="font-semibold text-pri">Gachi CLI Swarm</span>
      </div>
      <div className="flex-1" />
      {hideActions ? null : (
        <div className="flex items-center gap-2">
          <AiEnvironmentPanel />
          <SubscriptionLimitsButton />
          {actions}
          <TelegramSettingsButton />
          <NotificationSettingsButton />
        </div>
      )}
    </header>
  )
}
