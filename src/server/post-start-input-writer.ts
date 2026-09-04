import type { AgentManager } from './agent-manager.js'
import { getAgentDriver, isInteractiveAgentCommand } from './cli-driver.js'
import { taskStore } from './task-store.js'

const READY_CHECK_INTERVAL_MS = 50
const MIN_SUBMIT_AFTER_PASTE_DELAY_MS = 600
const MAX_SUBMIT_AFTER_PASTE_DELAY_MS = 1500
const PASTE_CHARS_PER_DELAY_MS = 4
const PASTE_ACK_CHECK_INTERVAL_MS = 50
const PASTE_ACK_SETTLE_DELAY_MS = 100
const PASTE_ACK_TIMEOUT_MS = 3000

export const toBracketedPasteSubmission = (text: string) => `\u001b[200~${text}\u001b[201~`

const getSubmitAfterPasteDelayMs = (text: string) =>
  Math.min(
    MAX_SUBMIT_AFTER_PASTE_DELAY_MS,
    Math.max(MIN_SUBMIT_AFTER_PASTE_DELAY_MS, Math.ceil(text.length / PASTE_CHARS_PER_DELAY_MS))
  )

export const hasInteractivePromptReady = (output: string, command = '') =>
  getAgentDriver(command).hasPromptReady(output)

export const hasBracketedPasteAcknowledgement = (output: string, baselineLength: number) =>
  /\[Pasted text #\d+/u.test(output.slice(baselineLength))

const isWritableRunStatus = (status: string | undefined) =>
  status === undefined || status === 'starting' || status === 'running'

const writeIfRunWritable = (agentManager: AgentManager, runId: string, text: string) => {
  let run: ReturnType<AgentManager['getRun']>
  try {
    run = agentManager.getRun(runId)
  } catch {
    return false
  }
  if (!isWritableRunStatus(run.status)) return false
  agentManager.writeInput(runId, text)
  return true
}

const submitPastedInteractiveInput = (
  agentManager: AgentManager,
  runId: string,
  text: string,
  baselineLength: number,
  waitForPasteAck: boolean,
  onSettled: () => void,
  onDelivered?: () => void
) => {
  const pastedAt = Date.now()
  const minDelay = getSubmitAfterPasteDelayMs(text)
  let acknowledgedAt: number | null = null

  const getWritableOutput = () => {
    try {
      const run = agentManager.getRun(runId)
      return isWritableRunStatus(run.status) ? run.output : null
    } catch {
      return null
    }
  }

  const submit = () => {
    try {
      if (writeIfRunWritable(agentManager, runId, '\r')) {
        onDelivered?.()
      }
    } catch {
      // The PTY may have exited between paste and submit.
    } finally {
      onSettled()
    }
  }

  const trySubmit = () => {
    if (!waitForPasteAck) {
      submit()
      return
    }

    const output = getWritableOutput()
    if (output === null) {
      onSettled()
      return
    }
    if (acknowledgedAt === null && hasBracketedPasteAcknowledgement(output, baselineLength)) {
      acknowledgedAt = Date.now()
    }

    const elapsed = Date.now() - pastedAt
    const ackSettled =
      acknowledgedAt !== null && Date.now() - acknowledgedAt >= PASTE_ACK_SETTLE_DELAY_MS
    if ((ackSettled && elapsed >= minDelay) || elapsed >= PASTE_ACK_TIMEOUT_MS) {
      submit()
      return
    }
    setTimeout(trySubmit, PASTE_ACK_CHECK_INTERVAL_MS)
  }

  setTimeout(trySubmit, minDelay)
}

/**
 * `onSettled` fires exactly once per `write()` call, on every terminal path
 * (submitted, dropped because the run became unwritable, or immediately for
 * non-interactive commands) — never on the recursive "still waiting for
 * prompt" branch. Callers use it to serialize writes to the same run so two
 * concurrent payloads (e.g. a heartbeat and a worker report) cannot interleave
 * mid-paste into the same PTY.
 * `onDelivered` fires only when the submission has actually completed and was
 * successfully written to the writable PTY.
 */
export const createPostStartInputWriter = (
  agentManager: AgentManager,
  command: string
): ((runId: string, text: string, onSettled?: () => void, onDelivered?: () => void) => void) => {
  if (!isInteractiveAgentCommand(command)) {
    return (runId, text, onSettled, onDelivered) => {
      try {
        if (writeIfRunWritable(agentManager, runId, `${text}\n`)) {
          onDelivered?.()
        }
      } finally {
        onSettled?.()
      }
    }
  }

  const driver = getAgentDriver(command)

  return (runId, text, onSettled, onDelivered) => {
    const startedAt = Date.now()
    let isInitialAttempt = true
    const settle = () => onSettled?.()
    const submitThenSettle = (baselineLength: number) => {
      submitPastedInteractiveInput(
        agentManager,
        runId,
        text,
        baselineLength,
        driver.usesBracketedPaste,
        settle,
        onDelivered
      )
    }
    let bypassedOnboarding = false
    const tryWrite = () => {
      let output: string | null
      try {
        const run = agentManager.getRun(runId)
        output = isWritableRunStatus(run.status) ? run.output : null
      } catch {
        settle()
        return
      }
      if (output === null) {
        settle()
        return
      }

      // Автоматическое проталкивание экранов подтверждения разрешений и onboarding (Claude / CLI)
      if (
        !bypassedOnboarding &&
        /bypass permissions|shift\+tab to cycle|press enter to continue/i.test(output)
      ) {
        bypassedOnboarding = true
        try {
          writeIfRunWritable(agentManager, runId, '\r')
        } catch {}
      }

      if (driver.hasPromptReady(output) || Date.now() - startedAt >= driver.readyTimeoutMs) {
        const baselineLength = output.length
        const input = driver.usesBracketedPaste ? toBracketedPasteSubmission(text) : text
        try {
          if (!writeIfRunWritable(agentManager, runId, input)) {
            settle()
            return
          }
        } catch (error) {
          settle()
          if (isInitialAttempt) throw error
          return
        }
        submitThenSettle(baselineLength)
        return
      }
      setTimeout(tryWrite, READY_CHECK_INTERVAL_MS)
    }
    try {
      tryWrite()
    } finally {
      isInitialAttempt = false
    }
  }
}

export const logTask = (taskId: string, message: string, workspaceId?: string) => {
  return taskStore.addLog(workspaceId, taskId, message)
}
