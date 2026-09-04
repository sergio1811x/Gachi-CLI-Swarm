import { execFileSync } from 'node:child_process'

import type { IPty } from 'node-pty'

import type { AgentRunRecord, AgentRunSnapshot } from './agent-manager.js'
import { PtyInactiveError } from './http-errors.js'
import type { PtyOutputBus } from './pty-output-bus.js'

export const MAX_RUN_OUTPUT_LENGTH = 1_000_000
const FORCE_KILL_DELAY_MS = 750

export const toAgentRunSnapshot = (run: AgentRunRecord): AgentRunSnapshot => ({
  runId: run.runId,
  agentId: run.agentId,
  pid: run.process.pid,
  paused: run.paused,
  status:
    run.process.isStopped() && run.status !== 'exited' && run.status !== 'error'
      ? 'error'
      : run.status,
  output: run.output,
  exitCode: run.exitCode,
})

export const finishAgentRun = (
  run: AgentRunRecord,
  exitCode: number | null,
  ptyOutputBus: PtyOutputBus
) => {
  if (run.status === 'exited' || run.status === 'error') return
  run.status = exitCode === 0 ? 'exited' : 'error'
  run.exitCode = exitCode
  try {
    run.onExit?.({ runId: run.runId, exitCode })
  } catch (error) {
    // A throwing exit listener must not swallow the PTY exit event for the
    // rest of the pipeline (bus teardown, downstream registry completion) or
    // propagate into the pty.onExit emitter as an uncaught exception.
    console.error(
      `[RUNTIME] run exit listener threw for run ${run.runId.slice(0, 8)}:`,
      error instanceof Error ? error.message : error
    )
  }
  ptyOutputBus.clear(run.runId)
}

export const attachAgentPty = (run: AgentRunRecord, pty: IPty, ptyOutputBus: PtyOutputBus) => {
  let stdinClosed = false
  let suspended = false
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined
  const resolveProcessGroupId = () => {
    if (process.platform === 'win32' || pty.pid <= 0) return null
    try {
      const value = execFileSync('ps', ['-o', 'pgid=', '-p', String(pty.pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      const groupId = Number(value)
      if (Number.isInteger(groupId) && groupId > 0) return groupId
    } catch {
      return pty.pid
    }
    return pty.pid
  }
  const processGroupId = resolveProcessGroupId()
  const stopped = () => run.status === 'exited' || run.status === 'error'
  const ignoreMissingProcess = (error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ESRCH') throw error
  }
  const ignoreBestEffortGroupKillError = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'ESRCH' && code !== 'EPERM') throw error
  }
  const killProcessGroup = (signal: NodeJS.Signals) => {
    if (process.platform === 'win32' || processGroupId === null) return
    try {
      process.kill(-processGroupId, signal)
    } catch (error) {
      ignoreBestEffortGroupKillError(error)
    }
  }
  const killPty = (signal: NodeJS.Signals) => {
    try {
      if (process.platform === 'win32') {
        // node-pty kills the cmd.exe wrapper but can leave its child CLI alive.
        // `taskkill /T` terminates the complete process tree, which is required
        // for a stop request to reliably emit the PTY exit event on Windows.
        execFileSync('taskkill', ['/pid', String(pty.pid), '/t', '/f'], {
          stdio: 'ignore',
        })
      } else pty.kill(signal)
    } catch (error) {
      ignoreMissingProcess(error)
    }
    killProcessGroup(signal)
  }
  const suspendPty = () => {
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `Suspend-Process -Id ${pty.pid}`], {
        stdio: 'ignore',
      })
      return
    }
    pty.kill('SIGSTOP')
    killProcessGroup('SIGSTOP')
  }
  const resumePty = () => {
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `Resume-Process -Id ${pty.pid}`], {
        stdio: 'ignore',
      })
      return
    }
    pty.kill('SIGCONT')
    killProcessGroup('SIGCONT')
  }
  const clearForceKillTimer = () => {
    if (!forceKillTimer) return
    clearTimeout(forceKillTimer)
    forceKillTimer = undefined
  }
  const cleanupProcessGroup = () => {
    clearForceKillTimer()
    killProcessGroup('SIGKILL')
  }
  const scheduleForceKill = () => {
    if (forceKillTimer) return
    forceKillTimer = setTimeout(() => {
      forceKillTimer = undefined
      try {
        if (process.platform === 'win32') pty.kill()
        else pty.kill('SIGKILL')
      } catch (error) {
        ignoreMissingProcess(error)
      }
      killProcessGroup('SIGKILL')
    }, FORCE_KILL_DELAY_MS)
    forceKillTimer.unref?.()
  }
  run.process = {
    isStopped() {
      return stopped()
    },
    pause() {
      if (stopped() || suspended) return
      suspendPty()
      pty.pause()
      suspended = true
      run.paused = true
    },
    pauseOutput() {
      if (stopped()) return
      // Flow control only: node-pty stops forwarding output to JS. The agent
      // process keeps running — a slow terminal viewer must never freeze it.
      pty.pause()
    },
    pid: pty.pid,
    resize(cols, rows) {
      pty.resize(cols, rows)
    },
    resume() {
      if (stopped() || !suspended) return
      resumePty()
      pty.resume()
      suspended = false
      run.paused = false
    },
    resumeOutput() {
      if (stopped()) return
      pty.resume()
    },
    stop() {
      if (stopped()) {
        cleanupProcessGroup()
        return
      }
      if (suspended) {
        resumePty()
        pty.resume()
        suspended = false
      }
      killPty('SIGTERM')
      stdinClosed = true
      scheduleForceKill()
    },
    write(text) {
      if (stdinClosed || suspended || run.status === 'exited' || run.status === 'error') {
        // Typed 409 signal: callers (control routes, dispatchers) surface this
        // as "agent not accepting input" instead of an opaque 500.
        throw new PtyInactiveError(`PTY is not active for run: ${run.runId}`)
      }
      pty.write(text)
    },
  }

  pty.onData((chunk) => {
    if (run.status === 'starting') run.status = 'running'
    run.output += chunk
    if (run.output.length > MAX_RUN_OUTPUT_LENGTH)
      run.output = run.output.slice(-MAX_RUN_OUTPUT_LENGTH)
    ptyOutputBus.publish(run.runId, chunk)
  })

  pty.onExit((event) => {
    stdinClosed = true
    cleanupProcessGroup()
    finishAgentRun(run, event.exitCode, ptyOutputBus)
  })
}
