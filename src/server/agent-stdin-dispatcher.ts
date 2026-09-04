import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import {
  buildOrchestratorHeartbeatPayload,
  buildOrchestratorTaskQueueUpdatePayload,
  buildWorkerReminderTail,
  buildWorkerReportNudgePayload,
} from './gachi-team-guidance.js'
import { PtyInactiveError } from './http-errors.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import { createPostStartInputWriter } from './post-start-input-writer.js'
import { taskStore } from './task-store.js'

interface AgentStdinDispatcherInput {
  agentManager: AgentManager | undefined
  getLaunchConfig: (workspaceId: string, agentId: string) => AgentLaunchConfigInput | undefined
  getWorkspaceId: (agentId: string) => string | undefined
  registry: LiveRunRegistry
  syncRun: (run: LiveAgentRun) => LiveAgentRun
}

export const buildOrchestratorReportPayload = (
  workerName: string,
  text: string,
  artifacts: string[],
  taskId?: string
): string => {
  const isLong = text.length > 250 || text.includes('\n')
  const preview = isLong
    ? `${text.trim().split('\n')[0]?.slice(0, 120)}... (полный результат записан в карточку задачи)`
    : text.trim()

  const lines: string[] = [
    `[Gachi system message: report from @${workerName}]`,
    `Задача${taskId ? ` #${taskId.slice(0, 8)}` : ''} выполнена и переведена в Review (🟡 ждет решения).`,
    `Отчёт: ${preview}`,
  ]
  if (artifacts.length > 0) {
    lines.push(`Артефакты: ${artifacts.join(', ')}`)
  }
  lines.push(
    `Команды: 'team accept' — утвердить в Done; 'team rework "<замечания>"' — вернуть на доработку.`
  )
  lines.push('')
  return lines.join('\n')
}

export const buildOrchestratorStatusPayload = (
  workerName: string,
  text: string,
  artifacts: string[]
): string => {
  const lines: string[] = [`[Gachi system message: status update from @${workerName}]`, text]
  for (const artifact of artifacts) lines.push(`artifact: ${artifact}`)
  lines.push('')
  return lines.join('\n')
}

export const buildOrchestratorUserInputPayload = (text: string): string => text

export const buildWorkerDispatchPayload = (
  fromAgentName: string,
  workerDescription: string,
  dispatchId: string,
  text: string,
  taskContext?: { id: string; title: string }
): string => {
  const lines = [
    `[Gachi system message: dispatch from @${fromAgentName}]`,
    '',
    `Your role: ${workerDescription}`,
  ]
  if (taskContext) {
    lines.push(
      `Task context: #${taskContext.id.slice(0, 8)} "${taskContext.title}"`,
      '',
      `[ВАЖНО: Это НОВАЯ уникальная задача #${taskContext.id.slice(0, 8)}. Полностью игнорируй результаты и файлы прошлых задач/сессий. Твоя цель — выполнить именно эту задачу и создать/обновить требуемые файлы на диске с нуля.]`
    )
  }
  lines.push(
    '',
    'You must:',
    '- VERIFY ON DISK: You MUST check that output files exist and are populated (Test-Path, ls, view_file) BEFORE reporting. Calling report without on-disk verification is FORBIDDEN.',
    `- For JSON, code, or long reports: write output to a file and run \`team report --file <path> --dispatch ${dispatchId}\` (RECOMMENDED).`,
    `- Run \`team report "<result>" --dispatch ${dispatchId}\` once done, failed, blocked, or partially complete.`,
    '- Not do unrelated work; report as soon as you are done.'
  )
  return [
    ...lines,
    '',
    `dispatch_id: ${dispatchId}`,
    '',
    'Task:',
    text,
    '',
    buildWorkerReminderTail(dispatchId),
    '',
  ].join('\n')
}

export const buildWorkerCancelPayload = (dispatchId: string, reason: string): string =>
  [
    `[Gachi system message: dispatch ${dispatchId} cancelled]`,
    '',
    'Stop working on this dispatch and do not call team report for it again.',
    '',
    'Cancellation reason:',
    reason,
    '',
  ].join('\n')

export const createAgentStdinDispatcher = ({
  agentManager,
  getLaunchConfig,
  getWorkspaceId,
  registry,
  syncRun,
}: AgentStdinDispatcherInput) => {
  // Serializes writes per runId: the interactive writer below can take up to
  // ~3s (waiting for a prompt, then a paste ack) before it actually submits.
  // Without this, two payloads racing for the same run (e.g. a heartbeat and
  // a worker report landing together) can interleave mid-paste in the PTY.
  // The first write for an idle run still runs synchronously (so callers see
  // synchronous errors, e.g. an immediate EPIPE, exactly as before); only
  // writes that arrive while one is already in flight get queued.
  const busyRunIds = new Set<string>()
  const pendingByRunId = new Map<string, Array<(onSettled: () => void) => void>>()

  const runNext = (runId: string, run: (onSettled: () => void) => void) => {
    busyRunIds.add(runId)
    let settled = false
    const onSettled = () => {
      if (settled) return
      settled = true
      const queue = pendingByRunId.get(runId)
      const next = queue?.shift()
      if (next) {
        runNext(runId, next)
        return
      }
      busyRunIds.delete(runId)
      pendingByRunId.delete(runId)
    }
    try {
      run(onSettled)
    } catch (error) {
      onSettled()
      throw error
    }
  }

  const enqueueWrite = (runId: string, run: (onSettled: () => void) => void) => {
    if (!busyRunIds.has(runId)) {
      runNext(runId, run)
      return
    }
    const queue = pendingByRunId.get(runId) ?? []
    queue.push(run)
    pendingByRunId.set(runId, queue)
  }

  const writeToActiveAgentRun = (
    workspaceId: string,
    agentId: string,
    text: string,
    input: { requireActiveRun?: boolean; onDelivered?: () => void } = {}
  ): boolean => {
    const run = registry
      .list()
      .filter((item) => item.agentId === agentId && getWorkspaceId(item.agentId) === workspaceId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .find((item) => {
        const status = syncRun(item).status
        return status === 'starting' || status === 'running'
      })
    if (!run) {
      if (input.requireActiveRun) {
        throw new PtyInactiveError(`No active run for agent: ${agentId}`)
      }
      return false
    }

    try {
      const config = getLaunchConfig(workspaceId, agentId)
      if (agentManager && config) {
        const writer = createPostStartInputWriter(
          agentManager,
          config.interactiveCommand ?? config.command
        )
        enqueueWrite(run.runId, (onSettled) =>
          writer(run.runId, text, onSettled, input.onDelivered)
        )
      } else {
        if (agentManager) {
          agentManager.writeInput(run.runId, text)
          input.onDelivered?.()
        }
      }
      return true
    } catch (error) {
      if (input.requireActiveRun) {
        throw new PtyInactiveError(error instanceof Error ? error.message : String(error))
      }
      return false
    }
  }

  return {
    writeReportPrompt(
      workspaceId: string,
      workerName: string,
      text: string,
      artifacts: string[],
      input: { requireActiveRun?: boolean; taskId?: string } = {}
    ) {
      writeToActiveAgentRun(
        workspaceId,
        `${workspaceId}:orchestrator`,
        buildOrchestratorReportPayload(workerName, text, artifacts, input.taskId),
        input
      )
    },
    writeStatusPrompt(
      workspaceId: string,
      workerName: string,
      text: string,
      artifacts: string[],
      input: { requireActiveRun?: boolean } = {}
    ) {
      writeToActiveAgentRun(
        workspaceId,
        `${workspaceId}:orchestrator`,
        buildOrchestratorStatusPayload(workerName, text, artifacts),
        input
      )
    },
    writeSendPrompt(
      workspaceId: string,
      workerId: string,
      dispatchId: string,
      fromAgentName: string,
      workerDescription: string,
      text: string,
      onDelivered?: () => void
    ) {
      const assignedTask = taskStore.getAssignedTaskForWorker(workspaceId, workerId)
      const taskContext = assignedTask
        ? { id: assignedTask.id, title: assignedTask.title }
        : undefined
      writeToActiveAgentRun(
        workspaceId,
        workerId,
        buildWorkerDispatchPayload(fromAgentName, workerDescription, dispatchId, text, taskContext),
        onDelivered ? { requireActiveRun: true, onDelivered } : { requireActiveRun: true }
      )
    },
    writeCancelPrompt(
      workspaceId: string,
      workerId: string,
      dispatchId: string,
      reason: string,
      input: { requireActiveRun?: boolean } = {}
    ) {
      writeToActiveAgentRun(
        workspaceId,
        workerId,
        buildWorkerCancelPayload(dispatchId, reason),
        input
      )
    },
    /**
     * Returns `true` only when the orchestrator has a writable run and the
     * payload was handed off. Telegram relay uses this to queue honestly
     * instead of claiming delivery into a dead PTY.
     */
    writeUserInputPrompt(workspaceId: string, text: string): boolean {
      return writeToActiveAgentRun(
        workspaceId,
        `${workspaceId}:orchestrator`,
        buildOrchestratorUserInputPayload(text)
      )
    },
    /** Returns false when the orchestrator has no writable run (nothing sent). */
    writeHeartbeatPrompt(workspaceId: string): boolean {
      const activeTasks = taskStore
        .listTasks(workspaceId)
        .filter(
          (t) =>
            t.status === 'assigned' ||
            t.status === 'running' ||
            t.status === 'ready' ||
            t.status === 'review'
        )
      const summary =
        activeTasks.length > 0
          ? activeTasks
              .map(
                (t) =>
                  `- Task #${t.id.slice(0, 8)} "${t.title}": status=${t.status}${
                    t.assignedAgentId ? ` (assigned: @${t.assignedAgentId})` : ''
                  }`
              )
              .join('\n')
          : undefined
      return this.writeOrchestratorPrompt(workspaceId, buildOrchestratorHeartbeatPayload(summary))
    },
    writeWorkerReportNudge(workspaceId: string, workerId: string, payload?: string) {
      writeToActiveAgentRun(workspaceId, workerId, payload ?? buildWorkerReportNudgePayload())
    },
    /**
     * Engine-aware interactive write for control-plane commands (context
     * actions, follow-up input): waits for the TUI prompt, pastes the text and
     * submits with a separate CR keystroke — the same reliable seam as task
     * dispatch. Returns false when the agent has no writable run.
     */
    writeInteractiveInput(workspaceId: string, agentId: string, text: string): boolean {
      try {
        return writeToActiveAgentRun(workspaceId, agentId, text, { requireActiveRun: true })
      } catch {
        return false
      }
    },
    /**
     * Best-effort raw payload injection into the orchestrator's active run.
     * Unlike the typed prompt writers this never throws: it reports success as
     * a boolean so callers (the orchestrator inbox flush) can keep payloads
     * queued when the orchestrator has no writable PTY right now.
     */
    writeOrchestratorPrompt(workspaceId: string, payload: string): boolean {
      try {
        writeToActiveAgentRun(workspaceId, `${workspaceId}:orchestrator`, payload)
        const hasRun = registry.list().some((item) => {
          if (item.agentId !== `${workspaceId}:orchestrator`) return false
          const status = syncRun(item).status
          return status === 'starting' || status === 'running'
        })
        // writeToActiveAgentRun silently returns when there is no active run;
        // that is "not delivered" from the inbox point of view.
        return hasRun
      } catch {
        return false
      }
    },
    writeTaskQueueUpdatePrompt(
      workspaceId: string,
      action: string,
      task: {
        id: string
        title: string
        status: string
        assignedWorkerName?: string | undefined
        details?: string | undefined
      }
    ) {
      const activeTasks = taskStore
        .listTasks(workspaceId)
        .filter((t) => t.status === 'assigned' || t.status === 'running' || t.status === 'ready')
      const summary =
        activeTasks.length > 0
          ? activeTasks
              .map(
                (t) =>
                  `- Task #${t.id.slice(0, 8)} "${t.title}": status=${t.status}${
                    t.assignedAgentId ? ` (assigned: @${t.assignedAgentId})` : ''
                  }`
              )
              .join('\n')
          : 'No other active tasks'
      writeToActiveAgentRun(
        workspaceId,
        `${workspaceId}:orchestrator`,
        buildOrchestratorTaskQueueUpdatePayload(action, task, summary)
      )
    },
  }
}
