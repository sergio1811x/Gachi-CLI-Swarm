/**
 * Memory watchdog: 10+ concurrent engine processes can exhaust the machine's
 * commit charge (Windows Resource-Exhaustion events, Chrome renderer kills,
 * silent daemon death on failed allocations). Instead of dying mid-flight the
 * daemon now:
 *
 * 1. Pauses NEW task dispatch globally when free physical memory drops below
 *    a threshold (app-state `memory_watchdog_free_percent`, default 8, `0`
 *    disables). Runs stay untouched — only fresh dispatch is held back. The
 *    flag auto-clears with hysteresis once memory recovers; it never touches
 *    the per-workspace error-budget `dispatch_paused_<wsId>` flags.
 * 2. Samples each live worker engine's RSS on the same tick and feeds the
 *    team-list telemetry (`rss_mb` on worker cards).
 * 3. Opt-in per-workspace rotation (`worker_mem_rotation_<wsId>` = RSS MB):
 *    an idle worker whose engine ballooned past the threshold gets a session-
 *    resume restart between tasks, returning its RAM to the system.
 * 4. Emergency rotation: while the global memory hold is ACTIVE the machine is
 *    close to an OOM crash, so an idle worker above EMERGENCY_ROTATION_RSS_MB
 *    is rotated even without the per-workspace opt-in — pausing fresh dispatch
 *    alone frees nothing, and the daemon itself dies on a failed allocation.
 */

import { execFile } from 'node:child_process'
import { freemem, totalmem } from 'node:os'
import { promisify } from 'node:util'
import { MEMORY_PAUSE_KEY } from './permission-mode.js'

export const MEMORY_WATCHDOG_FREE_PERCENT_KEY = 'memory_watchdog_free_percent'
export const WORKER_MEM_ROTATION_KEY_PREFIX = 'worker_mem_rotation_'

export const DEFAULT_FREE_PERCENT = 8
/** Resume only after memory recovers this many points above the threshold. */
export const HYSTERESIS_PERCENT_POINTS = 5
/** Never rotate a worker that just started — engines warm up their RSS. */
export const MIN_WORKER_UPTIME_MS = 10 * 60_000
/** One rotation per worker per cooldown window, so a fat engine cannot loop. */
export const ROTATION_COOLDOWN_MS = 30 * 60_000
/**
 * Hard RSS floor for rotation while the global memory hold is active: an idle
 * engine holding this much is returned to the system even when the workspace
 * never opted into `worker_mem_rotation_<wsId>`.
 */
export const EMERGENCY_ROTATION_RSS_MB = 2048

const execFileAsync = promisify(execFile)

interface AppStateStore {
  getAppState: (key: string) => { value: string | null } | undefined
  setAppState: (key: string, value: string) => void
}

export const readMemoryWatchdogThresholdPercent = (settings: AppStateStore): number => {
  const raw = Number.parseInt(
    settings.getAppState(MEMORY_WATCHDOG_FREE_PERCENT_KEY)?.value ?? '',
    10
  )
  if (!Number.isFinite(raw)) return DEFAULT_FREE_PERCENT
  return Math.min(90, Math.max(0, raw))
}

export const readRotationRssThresholdMb = (
  settings: AppStateStore,
  workspaceId: string
): number => {
  const raw = Number.parseInt(
    settings.getAppState(`${WORKER_MEM_ROTATION_KEY_PREFIX}${workspaceId}`)?.value ?? '',
    10
  )
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(65_536, Math.max(256, raw))
}

export interface MemoryWatchdogConfig {
  free_percent: number
  rotation_rss_mb: number | null
}

export const readMemoryWatchdogConfig = (
  settings: AppStateStore,
  workspaceId: string
): MemoryWatchdogConfig => ({
  free_percent: readMemoryWatchdogThresholdPercent(settings),
  rotation_rss_mb: readRotationRssThresholdMb(settings, workspaceId) || null,
})

export const computeFreeMemoryPercent = (): number => {
  const total = totalmem()
  if (total <= 0) return 100
  return (freemem() / total) * 100
}

/**
 * RSS in MB per pid. Best-effort: dead/racy pids are simply absent.
 * On Windows the PTY pid is the `cmd.exe` wrapper (see resolveSpawnCommand)
 * whose ~6 MB working set says nothing about the engine — the real CLI is a
 * grandchild, so the sample walks the process tree and reports the largest
 * working set among the wrapper's descendants.
 */
export const sampleProcessRss = async (pids: number[]): Promise<Map<number, number>> => {
  if (pids.length === 0) return new Map()
  const unique = [...new Set(pids)].sort((a, b) => a - b)
  const result = new Map<number, number>()
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize | ' +
          "ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize }",
      ])
      const wsByPid = new Map<number, number>()
      const childrenByParent = new Map<number, number[]>()
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(line.trim())
        if (!match) continue
        const pid = Number(match[1])
        const parent = Number(match[2])
        wsByPid.set(pid, Number(match[3]))
        const siblings = childrenByParent.get(parent)
        if (siblings) siblings.push(pid)
        else childrenByParent.set(parent, [pid])
      }
      for (const root of unique) {
        let maxWs = wsByPid.get(root) ?? 0
        const queue = [root]
        const visited = new Set<number>([root])
        while (queue.length > 0) {
          const current = queue.pop() as number
          for (const child of childrenByParent.get(current) ?? []) {
            if (visited.has(child)) continue
            visited.add(child)
            maxWs = Math.max(maxWs, wsByPid.get(child) ?? 0)
            queue.push(child)
          }
        }
        if (maxWs > 0) result.set(root, Math.round(maxWs / 1_048_576))
      }
    } else {
      const { stdout } = await execFileAsync('ps', ['-o', 'pid=,rss=', '-p', unique.join(',')])
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(\d+)$/.exec(line)
        if (!match) continue
        result.set(Number(match[1]), Math.round(Number(match[2]) / 1024))
      }
    }
  } catch {
    // Telemetry is best-effort — an empty sample just hides the chip.
  }
  return result
}

export interface WorkerMemoryCache {
  record: (key: string, rssMb: number, sampledAt: number) => void
  get: (key: string) => number | null
}

export const createWorkerMemoryCache = (
  maxAgeMs: number,
  now: () => number = Date.now
): WorkerMemoryCache => {
  const samples = new Map<string, { rssMb: number; sampledAt: number }>()
  return {
    record: (key, rssMb, sampledAt) => {
      samples.set(key, { rssMb, sampledAt })
    },
    get: (key) => {
      const entry = samples.get(key)
      if (!entry) return null
      if (now() - entry.sampledAt > maxAgeMs) return null
      return entry.rssMb
    },
  }
}

export interface RotationCandidate {
  workspaceId: string
  agentId: string
  name: string
  pid: number
  startedAt: number
}

export interface MemoryWatchdogDeps {
  settings: AppStateStore
  listRotationCandidates: () => RotationCandidate[]
  restartWorker: (workspaceId: string, agentId: string) => Promise<void>
  emitQueueUpdated?: (workspaceId: string) => void
  listWorkspaceIds?: () => string[]
  notify?: (text: string) => void
  getFreeMemoryPercent?: () => number
  sampleRss?: (pids: number[]) => Promise<Map<number, number>>
  intervalMs?: number
  now?: () => number
}

export interface MemoryWatchdog {
  tick: () => Promise<void>
  stop: () => void
  getWorkerRssMb: (workspaceId: string, agentId: string) => number | null
  isMemoryPauseActive: () => boolean
}

export const sampleKey = (workspaceId: string, agentId: string) => `${workspaceId}:${agentId}`

export const createMemoryWatchdog = (deps: MemoryWatchdogDeps): MemoryWatchdog => {
  const now = deps.now ?? (() => Date.now())
  const cache = createWorkerMemoryCache(3 * 60_000, now)
  const rotationLastAt = new Map<string, number>()
  let pausedByWatchdog = false

  const emitPauseStateToWorkspaces = () => {
    for (const workspaceId of deps.listWorkspaceIds?.() ?? []) {
      try {
        deps.emitQueueUpdated?.(workspaceId)
      } catch {
        // UI refresh is best-effort.
      }
    }
  }

  const pauseDispatch = (freePercent: number, threshold: number) => {
    pausedByWatchdog = true
    deps.settings.setAppState(MEMORY_PAUSE_KEY, '1')
    console.warn(
      `[MEMORY] free memory ${freePercent.toFixed(1)}% < ${threshold}% — dispatch paused globally`
    )
    deps.notify?.(
      `🧠 Мало памяти: свободно ${freePercent.toFixed(1)}% (порог ${threshold}%). ` +
        'Диспетчер задач приостановлен для новых раздач; запущенные задачи не тронуты.'
    )
    emitPauseStateToWorkspaces()
  }

  const resumeDispatch = (freePercent: number, threshold: number) => {
    pausedByWatchdog = false
    deps.settings.setAppState(MEMORY_PAUSE_KEY, '0')
    console.log(
      `[MEMORY] memory recovered (${freePercent.toFixed(1)}% >= ${threshold}% + hysteresis) — dispatch resumed`
    )
    deps.notify?.(
      `✅ Память восстановилась (${freePercent.toFixed(1)}%). Диспетчер задач возобновил раздачу.`
    )
    emitPauseStateToWorkspaces()
  }

  const maybeRotate = (candidate: RotationCandidate, rssMb: number) => {
    // Under the global memory hold the daemon is near an OOM crash, so the
    // emergency floor applies even when the workspace never opted in.
    const optInMb = readRotationRssThresholdMb(deps.settings, candidate.workspaceId)
    const emergency = pausedByWatchdog && rssMb >= EMERGENCY_ROTATION_RSS_MB
    const thresholdMb = Math.max(optInMb, emergency ? EMERGENCY_ROTATION_RSS_MB : 0)
    if (thresholdMb <= 0 || rssMb < thresholdMb) return
    const key = sampleKey(candidate.workspaceId, candidate.agentId)
    const startedAt = candidate.startedAt
    if (now() - startedAt < MIN_WORKER_UPTIME_MS) return
    const last = rotationLastAt.get(key)
    if (last !== undefined && now() - last < ROTATION_COOLDOWN_MS) return
    rotationLastAt.set(key, now())
    console.warn(
      `[MEMORY] rotating @${candidate.name} (rss ${rssMb} MB >= ${thresholdMb} MB, idle` +
        `${emergency && optInMb <= 0 ? ', emergency hold' : ''}) — ` +
        'session-resume restart between tasks'
    )
    void deps
      .restartWorker(candidate.workspaceId, candidate.agentId)
      .catch((error: unknown) =>
        console.error(
          `[MEMORY] rotation restart failed for @${candidate.name}:`,
          error instanceof Error ? error.message : error
        )
      )
  }

  const tick = async (): Promise<void> => {
    // 1) RSS sampling + opt-in rotation. Runs even when the pause threshold is
    // disabled: telemetry must not depend on the safety trigger.
    const candidates = deps.listRotationCandidates()
    if (candidates.length > 0) {
      const samples = await (deps.sampleRss ?? sampleProcessRss)(
        candidates.map((candidate) => candidate.pid)
      )
      for (const candidate of candidates) {
        const rssMb = samples.get(candidate.pid)
        if (rssMb === undefined) continue
        cache.record(sampleKey(candidate.workspaceId, candidate.agentId), rssMb, now())
        maybeRotate(candidate, rssMb)
      }
    }

    // 2) Global pause decision with hysteresis.
    const threshold = readMemoryWatchdogThresholdPercent(deps.settings)
    const freePercent = deps.getFreeMemoryPercent?.() ?? computeFreeMemoryPercent()
    if (threshold <= 0) {
      // Watchdog disabled while paused → release the hold instead of wedging.
      if (pausedByWatchdog) resumeDispatch(freePercent, threshold)
      return
    }
    if (!pausedByWatchdog && freePercent < threshold) {
      pauseDispatch(freePercent, threshold)
    } else if (pausedByWatchdog && freePercent >= threshold + HYSTERESIS_PERCENT_POINTS) {
      resumeDispatch(freePercent, threshold)
    }
  }

  const intervalMs = deps.intervalMs ?? 60_000
  const timer = setInterval(
    () => void tick().catch((error) => console.error('[MEMORY] tick failed:', error)),
    intervalMs
  )
  timer.unref?.()

  return {
    tick,
    stop: () => clearInterval(timer),
    getWorkerRssMb: (workspaceId, agentId) => cache.get(sampleKey(workspaceId, agentId)),
    isMemoryPauseActive: () => pausedByWatchdog,
  }
}
