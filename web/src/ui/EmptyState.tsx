import type { ReactNode } from 'react'

type EmptyStateProps = {
  title: string
  description: string
  icon?: ReactNode
  action?: ReactNode
}

/**
 * Empty / error state surface — used by sidebar (no workspaces),
 * workers pane (no team yet), and orchestrator (idle / failed).
 *
 * The icon plate (when icon provided) gives empty states presence — without
 * it, "absent" content reads as broken UI. Plate uses bg-2 + border + inset
 * highlight so it sits on the surface like a dimensional badge.
 */
export const EmptyState = ({ title, description, icon, action }: EmptyStateProps) => (
  <div
    className="m-auto flex max-w-[400px] flex-col items-center gap-4 px-6 py-8 text-center"
    data-testid="empty-state"
  >
    {icon ? (
      <div
        data-testid="empty-state-icon"
        aria-hidden
        className="flex h-16 w-16 items-center justify-center rounded-xl text-accent"
        style={{
          background:
            'radial-gradient(circle at 30% 20%, color-mix(in oklab, var(--accent) 18%, var(--bg-2)), var(--bg-2))',
          border: '1px solid color-mix(in oklab, var(--accent) 28%, var(--border-bright))',
          boxShadow: '0 8px 24px rgba(var(--shadow-tint), 0.28)',
        }}
      >
        {icon}
      </div>
    ) : null}
    <div className="font-display text-xl font-semibold text-pri" data-testid="empty-state-title">
      {title}
    </div>
    <div className="text-sm text-ter" data-testid="empty-state-description">
      {description}
    </div>
    {action ? <div className="mt-1">{action}</div> : null}
  </div>
)
