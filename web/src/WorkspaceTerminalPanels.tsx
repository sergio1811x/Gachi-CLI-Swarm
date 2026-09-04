import type { TerminalRunSummary } from './api.js'
import { useI18n } from './i18n.js'
import { TerminalView } from './terminal/TerminalView.js'
import { mergeTerminalRuns } from './terminal/useOptimisticTerminalRuns.js'

type WorkspaceTerminalPanelsProps = {
  hidden?: boolean
  optimisticRuns?: TerminalRunSummary[]
  terminalRuns: TerminalRunSummary[]
  workspaceId: string
}

export const WorkspaceTerminalPanels = ({
  hidden = false,
  optimisticRuns = [],
  terminalRuns,
  workspaceId,
}: WorkspaceTerminalPanelsProps) => {
  const { t } = useI18n()
  const mergedRuns = mergeTerminalRuns(terminalRuns, optimisticRuns, workspaceId)

  return (
    <section
      hidden={hidden}
      aria-hidden={hidden || undefined}
      aria-label={t('terminalPanels.aria')}
    >
      {mergedRuns.map((run) => (
        <TerminalView
          inputProfile={run.terminal_input_profile ?? 'default'}
          key={run.run_id}
          runId={run.run_id}
          title={`${run.agent_name} (${run.status})`}
        />
      ))}
    </section>
  )
}
