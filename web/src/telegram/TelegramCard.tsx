import type { ReactNode } from 'react'

interface TelegramCardProps {
  children: ReactNode
  label: string
  testId?: string
}

/**
 * One flat section of the Telegram settings drawer (ТЗ v3): a 10px uppercase
 * label over content, separated from neighbours by a hairline only — no card
 * background, no radius, no extra chrome.
 */
export const TelegramCard = ({ children, label, testId }: TelegramCardProps) => (
  <section className="settings-section" data-testid={testId}>
    <div className="settings-section__label">{label}</div>
    {children}
  </section>
)
