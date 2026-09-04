import { randomUUID } from 'node:crypto'
import { spawn } from 'node-pty'
import { resolveSpawnCommand } from './agent-command-resolver.js'
import { attachAgentPty, toAgentRunSnapshot } from './agent-manager-support.js'
import { stopRunProcessTree, trackStopEscalation } from './process-tree-kill.js'
import { createPtyOutputBus, type PtyOutputBus } from './pty-output-bus.js'

type RunStatus = 'starting' | 'running' | 'exited' | 'error'

interface StartAgentInput {
  agentId: string
  command: string
  args?: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  onExit?: (event: { runId: string; exitCode: number | null }) => void
}

interface AgentRunSnapshot {
  runId: string
  agentId: string
  pid: number | null
  status: RunStatus
  output: string
  exitCode: number | null
  /** True while the OS process is suspended by an explicit user pause. */
  paused: boolean
}

interface AgentRunRecord extends AgentRunSnapshot {
  process: {
    isStopped: () => boolean
    /** Full freeze: suspend the OS process (SIGSTOP / Suspend-Process). */
    pause: () => void
    /**
     * Flow control only: stop reading PTY output into JS without touching the
     * OS process. Used by terminal-viewer backpressure — a slow browser must
     * never freeze a working agent.
     */
    pauseOutput: () => void
    pid: number | null
    resize: (cols: number, rows: number) => void
    resume: () => void
    resumeOutput: () => void
    stop: () => void
    write: (input: Buffer | string) => void
  }
  onExit?: (event: { runId: string; exitCode: number | null }) => void
}

interface AgentManager {
  getOutputBus: () => PtyOutputBus
  pauseRun: (runId: string) => void
  /** Output-flow pause only — the agent process keeps running. */
  pauseRunOutput: (runId: string) => void
  resizeRun: (runId: string, cols: number, rows: number) => void
  resumeRun: (runId: string) => void
  resumeRunOutput: (runId: string) => void
  startAgent: (input: StartAgentInput) => Promise<AgentRunSnapshot>
  writeInput: (runId: string, input: Buffer | string) => void
  getRun: (runId: string) => AgentRunSnapshot
  removeRun: (runId: string) => void
  stopRun: (runId: string) => void
}

const createRunId = () => randomUUID()

/**
 * Grace period after a process exits before its node-pty record is dropped from
 * the manager. Short enough to free memory, long enough for any terminal viewer
 * or run-history caller still reading the finished run (the live registry keeps
 * finished runs for up to 10 minutes, and `syncRun` tolerates the missing
 * record). Without this the manager retained every spawned PTY for the whole
 * daemon lifetime — a steady memory leak.
 */
const FINISHED_RUN_CLEANUP_DELAY_MS = 60_000

const createSpawnEnv = (inputEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env = { ...process.env, ...inputEnv }
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key]
  }
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path')
  if (pathKeys.length > 0) {
    let primaryPath = ''
    if (inputEnv) {
      const inputKey = Object.keys(inputEnv).find((k) => k.toLowerCase() === 'path')
      if (inputKey && inputEnv[inputKey]) {
        primaryPath = inputEnv[inputKey] ?? ''
      }
    }
    if (!primaryPath) {
      primaryPath =
        pathKeys
          .map((k) => env[k])
          .find((v): v is string => typeof v === 'string' && v.length > 0) ?? ''
    }
    for (const k of pathKeys) {
      env[k] = primaryPath
    }
    env.PATH = primaryPath
    env.Path = primaryPath
  }
  return env
}

export const createAgentManager = ({
  ptyOutputBus = createPtyOutputBus(),
}: {
  ptyOutputBus?: PtyOutputBus
} = {}): AgentManager => {
  const runs = new Map<string, AgentRunRecord>()

  const getRunRecord = (runId: string) => {
    const run = runs.get(runId)
    if (!run) throw new Error(`Run not found: ${runId}`)
    return run
  }

  return {
    getOutputBus() {
      return ptyOutputBus
    },
    pauseRun(runId) {
      getRunRecord(runId).process.pause()
    },
    pauseRunOutput(runId) {
      getRunRecord(runId).process.pauseOutput()
    },
    resumeRunOutput(runId) {
      getRunRecord(runId).process.resumeOutput()
    },
    async startAgent(input) {
      const env = createSpawnEnv(input.env)
      const spawnCommand = resolveSpawnCommand(input.command, input.cwd, env, input.args ?? [])

      const runId = createRunId()

      const run: AgentRunRecord = {
        runId,
        agentId: input.agentId,
        paused: false,
        pid: null,
        status: 'starting',
        output: '',
        exitCode: null,
        process: {
          isStopped() {
            return false
          },
          pause() {},
          pauseOutput() {},
          pid: null,
          resize() {},
          resume() {},
          resumeOutput() {},
          stop() {},
          write() {},
        },
      }

      if (input.onExit) {
        const onExit = input.onExit
        run.onExit = (event) => {
          onExit(event)
          // Free the dead PTY record shortly after exit so node-pty objects
          // don't accumulate for the daemon's lifetime.
          const cleanupTimer = setTimeout(() => runs.delete(runId), FINISHED_RUN_CLEANUP_DELAY_MS)
          cleanupTimer.unref?.()
        }
      }

      runs.set(runId, run)

      try {
        attachAgentPty(
          run,
          spawn(spawnCommand.command, spawnCommand.args, {
            cwd: input.cwd,
            env,
            name: 'xterm-256color',
          }),
          ptyOutputBus
        )
      } catch (error) {
        runs.delete(runId)
        throw error
      }

      return toAgentRunSnapshot(run)
    },

    resizeRun(runId, cols, rows) {
      getRunRecord(runId).process.resize(cols, rows)
    },

    resumeRun(runId) {
      getRunRecord(runId).process.resume()
    },

    writeInput(runId, text) {
      getRunRecord(runId).process.write(text)
    },

    getRun(runId) {
      return toAgentRunSnapshot(getRunRecord(runId))
    },

    removeRun(runId) {
      runs.delete(runId)
    },

    stopRun(runId) {
      const run = getRunRecord(runId)
      // Windows ConPTY: pty.kill() alone routinely leaves the spawned CLI tree
      // alive (orphaned claude.exe burning tokens while the UI says stopped).
      // Escalation is tracked so a daemon shutdown can wait for it.
      trackStopEscalation(stopRunProcessTree(run.pid, () => run.process.stop()))
    },
  }
}

export type { AgentManager, AgentRunRecord, AgentRunSnapshot, RunStatus, StartAgentInput }
