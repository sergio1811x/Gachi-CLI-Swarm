#!/usr/bin/env node

import { once } from 'node:events'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentManager } from '../server/agent-manager.js'
import { createApp } from '../server/app.js'
import { readEnv } from '../server/env.js'
import { autostartAgent, autostartOrchestrator } from '../server/orchestrator-autostart.js'
import { readPackageVersion } from '../server/package-version.js'
import { createRuntimeStore, type RuntimeStore } from '../server/runtime-store.js'
import { taskStore } from '../server/task-store.js'
import { getOrchestratorId } from '../server/workspace-store-support.js'
import { runDoctorCommand } from './doctor.js'
import { collectPreflightWarnings } from './preflight.js'

/**
 * При запуске рантайма:
 * 1. Возобновляет работу оркестратора в каждом воркспейсе.
 * 2. Автоматически оживляет (autostart) всех воркеров, у которых есть активные задачи
 *    или задачи в очереди (pendingTaskCount > 0 / статус open/in_progress), чтобы работа не простаивала.
 */
const autostartWorkspaceAgents = async (store: RuntimeStore, gachiPort: string) => {
  await Promise.all(
    store.listWorkspaces().map(async (workspace) => {
      // 1. Авто-запуск оркестратора
      const orchestratorId = getOrchestratorId(workspace.id)
      if (
        !store.getActiveRunByAgentId(workspace.id, orchestratorId) &&
        store.peekAgentLaunchConfig(workspace.id, orchestratorId)
      ) {
        const result = await autostartOrchestrator(store, workspace.id, orchestratorId, gachiPort)
        if (!result.ok) {
          console.error(
            `[gachi] failed to resume orchestrator for workspace ${workspace.id}: ${result.error}`
          )
        }
      }

      // 2. Авто-запуск воркеров с задачами
      const workers = store.listWorkers(workspace.id)
      const tasks = taskStore.listTasks(workspace.id)

      for (const worker of workers) {
        const hasPendingTask = worker.pendingTaskCount > 0
        const hasActiveTask = tasks.some(
          (t) =>
            t.assignedAgentId === worker.id &&
            (t.status === 'assigned' || t.status === 'running' || t.status === 'review')
        )

        if (hasPendingTask || hasActiveTask) {
          if (
            !store.getActiveRunByAgentId(workspace.id, worker.id) &&
            store.peekAgentLaunchConfig(workspace.id, worker.id)
          ) {
            console.log(`[gachi] Возобновление работы воркера @${worker.name} (активные задачи)...`)
            await autostartAgent(store, workspace.id, worker.id, gachiPort, {
              missingConfigError: `No launch config for worker ${worker.name}`,
            }).catch((err) => {
              console.error(`[gachi] Ошибка авто-запуска воркера @${worker.name}:`, err)
            })
          }
        }
      }
    })
  )
}

interface RunGachiCommandResult {
  port: number
  close: () => Promise<void>
  store: RuntimeStore
}

type ListenError = Error & {
  address?: string
  code?: string
  port?: number
}

export const GACHI_USAGE = [
  'Usage:',
  '  gachi [--port <port>]',
  '',
  'Options:',
  '  --port <port>   Bind the local runtime to a specific port (default: 3000).',
  '  -h, --help      Print this help.',
  '  -v, --version   Print the installed version.',
].join('\n')

export const handleGachiInfoCommand = (argv: string[]) => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(GACHI_USAGE)
    return true
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(readPackageVersion())
    return true
  }
  return false
}

const parsePort = (argv: string[]) => {
  let parsedPort: number | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg !== '--port') {
      if (arg?.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
      if (arg) throw new Error(`Unknown argument: ${arg}`)
      continue
    }

    const value = argv[index + 1]
    if (!value) {
      throw new Error('Usage: gachi [--port <port>]')
    }

    const port = Number.parseInt(value, 10)
    if (Number.isNaN(port) || port < 0) {
      throw new Error(`Invalid port: ${value}`)
    }

    parsedPort = port
    index += 1
  }

  return parsedPort ?? 3000
}

const resolveDataDir = (): string => {
  if (process.env.GACHI_DATA_DIR) return process.env.GACHI_DATA_DIR
  const fromEnv = readEnv('DATA_DIR')
  if (fromEnv) return fromEnv
  return join(homedir(), '.config', 'gachi')
}

const isListenError = (error: unknown): error is ListenError =>
  error instanceof Error && typeof (error as ListenError).code === 'string'

const formatPortInUseMessage = (port: number) =>
  [
    `Could not start because port ${port} is already in use.`,
    '',
    'Another instance may already be running:',
    `  http://127.0.0.1:${port}`,
    '',
    'Options:',
    '  - Open the existing window.',
    '  - Stop the process using that port:',
    `      lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill`,
    '  - Start on another port:',
    `      gachi --port ${port + 1}`,
  ].join('\n')

const formatListenError = (error: unknown, requestedPort: number) => {
  if (isListenError(error) && error.code === 'EADDRINUSE') {
    return new Error(formatPortInUseMessage(error.port ?? requestedPort))
  }
  return error
}

export const runGachiCommand = async (argv: string[]): Promise<RunGachiCommandResult> => {
  const port = parsePort(argv)
  const dataDir = resolveDataDir()

  // R7 preflight: warn (never block) about a broken environment before the
  // server binds, so first-run users see actionable output immediately.
  for (const warning of await collectPreflightWarnings()) {
    console.warn(`[preflight] ${warning.label} — ${warning.fix}`)
  }

  const app = createApp({
    store: createRuntimeStore({
      agentManager: createAgentManager(),
      dataDir,
      // Startup recovery mutates SQLite (lifecycle settles, task requeues,
      // orphan-run failures). Running it before the bind meant a port
      // conflict could damage the LIVE instance's state — the 2026-08-30
      // restart-loop incident killed that instance's workers and burned its
      // error budget once per supervisor cycle. Recover only once this
      // process owns the port.
      deferStartupRecovery: true,
    }),
  })

  try {
    app.server.listen(port, '127.0.0.1')
    await Promise.race([
      once(app.server, 'listening'),
      once(app.server, 'error').then(([error]) => {
        throw error
      }),
    ])
  } catch (error) {
    await app.store.close()
    throw formatListenError(error, port)
  }

  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }
  app.store.setRuntimePort(String(address.port))

  let closePromise: Promise<void> | null = null
  const close = async () => {
    if (closePromise) {
      return closePromise
    }

    closePromise = (async () => {
      process.off('SIGTERM', gracefulShutdown)
      process.off('SIGINT', gracefulShutdown)
      await new Promise<void>((resolve, reject) => {
        app.server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
      await app.store.close()
    })()

    return closePromise
  }

  const gracefulShutdown = () => {
    void close()
      .then(() => {
        process.exit(0)
      })
      .catch((error) => {
        console.error(error)
        process.exit(1)
      })
  }

  process.once('SIGTERM', gracefulShutdown)
  process.once('SIGINT', gracefulShutdown)

  // A single rejected promise in any void-ed async loop (dispatcher, recovery,
  // nudge, heartbeat) used to take down the whole daemon. Log it loudly and
  // keep serving so the orchestrator/workers don't silently collapse.
  process.on('unhandledRejection', (reason) => {
    console.error(
      '[gachi] unhandled rejection (daemon kept alive):',
      reason instanceof Error ? (reason.stack ?? reason.message) : reason
    )
  })
  process.on('uncaughtException', (error) => {
    console.error('[gachi] uncaught exception (daemon kept alive):', error.stack ?? error)
  })

  console.log(`Gachi CLI Swarm running at http://127.0.0.1:${address.port}`)
  // Recovery and initial dispatch run only after this instance owns the port.
  try {
    app.store.runStartupRecovery()
  } catch (error) {
    console.error('[gachi] startup recovery failed:', error)
  }
  void autostartWorkspaceAgents(app.store, String(address.port)).catch((error: unknown) => {
    console.error('[gachi] failed to resume workspace agents', error)
  })

  return {
    port: address.port,
    close,
    store: app.store,
  }
}

export type { RunGachiCommandResult }

const isMainModule = process.argv[1]
  ? fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  : false

if (isMainModule) {
  const argv = process.argv.slice(2)
  if (argv[0] === 'doctor') {
    void runDoctorCommand().then((code) => {
      process.exit(code)
    })
  } else if (handleGachiInfoCommand(argv)) {
    process.exit(0)
  } else {
    runGachiCommand(argv).catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
  }
}
