import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { detectAgentAuth } from '../server/agent-discovery/auth-detector.js'
import { detectInstalledAgents } from '../server/agent-discovery/cli-detector.js'
import { findEngineAdapter } from '../server/engine-adapters.js'
import { readEnv } from '../server/env.js'

/**
 * `gachi doctor` (spec §8): one-shot environment health report. Runs fully
 * offline against the local machine + runtime DB; exits non-zero when a
 * core component is broken so it can gate scripts/CI.
 */

const exec = promisify(execFile)

const OK = '✓'
const BAD = '✗'
const WARN = '!'

const line = (status: string, label: string, detail: string) =>
  ` ${status}  ${label.padEnd(12)} ${detail}`

const hint = (text: string) => console.log(`     └─ Fix: ${text}`)

/** R8: minimum supported runtime with a machine-checkable verdict. */
export const evaluateNodeVersion = (
  version: string
): { ok: boolean; major: number; detail: string; fix: string | null } => {
  const major = Number(version.replace(/^v/, '').split('.')[0])
  if (major >= 22) return { ok: true, major, detail: version, fix: null }
  return {
    detail: `${version} — too old`,
    fix: 'install Node.js 22+ LTS from https://nodejs.org (or via nvm/winget), then reopen the terminal',
    major,
    ok: false,
  }
}

const readFirstLine = async (file: string, args: string[]): Promise<string | null> => {
  try {
    const { stdout } = await exec(file, args, { timeout: 8_000, windowsHide: true })
    return stdout.split(/\r?\n/)[0]?.trim() ?? null
  } catch {
    return null
  }
}

const resolveDataDir = (): string => {
  if (process.env.GACHI_DATA_DIR) return process.env.GACHI_DATA_DIR
  const fromEnv = readEnv('DATA_DIR')
  if (fromEnv) return fromEnv
  return join(homedir(), '.config', 'gachi')
}

const checkTelegramToken = (): { present: boolean; sealed: boolean; unknown: boolean } => {
  const dataDir = resolveDataDir()
  const dbPath = join(dataDir, 'runtime.sqlite')
  if (!existsSync(dbPath)) return { present: false, sealed: false, unknown: true }
  try {
    // Lazy require keeps the doctor usable without the app's node_modules.
    const Database = require('better-sqlite3') as new (
      path: string,
      options?: { readonly?: boolean }
    ) => {
      prepare: (sql: string) => {
        get: (...args: unknown[]) => { value: string | null } | undefined
      }
      close: () => void
    }
    const db = new Database(dbPath, { readonly: true })
    const row = db.prepare("SELECT value FROM app_state WHERE key = 'telegram_bot_token'").get() as
      | { value: string | null }
      | undefined
    db.close()
    const value = row?.value ?? null
    return {
      present: Boolean(value),
      sealed: Boolean(value?.startsWith('dpapi:v1:') || value?.startsWith('plain:v1:')),
      unknown: false,
    }
  } catch {
    // Runtime holds the DB (app is running) — report honestly instead of a
    // false "not configured".
    return { present: false, sealed: false, unknown: true }
  }
}

export const runDoctorCommand = async (): Promise<number> => {
  console.log('Gachi doctor — environment report\n')

  const node = evaluateNodeVersion(process.version)
  console.log(line(node.ok ? OK : BAD, 'Node', node.detail))
  if (node.fix) hint(node.fix)
  let failures = node.ok ? 0 : 1

  const gitVersion = await readFirstLine('git', ['--version'])
  console.log(gitVersion ? line(OK, 'Git', gitVersion) : line(BAD, 'Git', 'not found in PATH'))
  if (!gitVersion) {
    failures += 1
    hint(
      'install Git (https://git-scm.com or `winget install --id Git.Git`), then reopen the terminal'
    )
  }

  const agents = await detectInstalledAgents()
  for (const agent of agents) {
    const adapter = findEngineAdapter(agent.name)
    if (!agent.installed) {
      console.log(line(WARN, agent.name, 'not installed'))
      hint(
        `install the ${adapter?.displayName ?? agent.name} CLI and make sure \`${agent.name}\` is on PATH`
      )
      continue
    }
    const auth = detectAgentAuth(agent.name)
    const version = agent.version ?? 'version unknown'
    const authText = auth.authenticated ? `auth: ${auth.method}` : 'NOT authenticated'
    console.log(line(auth.authenticated ? OK : WARN, agent.name, `${version} · ${authText}`))
    if (!auth.authenticated && !auth.error) continue
    if (auth.error) console.log(`     └─ ${auth.error}`)
    if (!auth.authenticated) {
      hint(adapter?.loginHint ?? `authenticate \`${agent.name}\` once, then rerun \`gachi doctor\``)
    }
  }

  const dataDir = resolveDataDir()
  const dbPath = join(dataDir, 'runtime.sqlite')
  const dbOk = existsSync(dbPath)
  console.log(
    dbOk ? line(OK, 'Database', dbPath) : line(WARN, 'Database', `not created yet (${dataDir})`)
  )
  if (!dbOk) hint('created automatically on first server start (`gachi start`) — nothing to do now')

  const telegram = checkTelegramToken()
  const telegramKnown = telegram.present
    ? line(OK, 'Telegram', `token stored${telegram.sealed ? ' (sealed at rest)' : ''}`)
    : telegram.unknown
      ? line(WARN, 'Telegram', 'token state unknown (database busy or missing)')
      : line(WARN, 'Telegram', 'no bot token configured')
  console.log(telegramKnown)
  if (!telegram.present && !telegram.unknown) {
    hint('optional — pair a bot via web UI → Settings → Telegram to get phone notifications')
  }

  // R5→R10 Docker sandbox support check (WARN-only — sandbox is opt-in).
  const dockerVersion = await readFirstLine('docker', ['--version'])
  if (dockerVersion) {
    console.log(line(OK, 'Docker', dockerVersion))
    hint(
      'optional — enable per-workspace sandbox via app-state worker_sandbox_<id>=docker; engines with env-key auth work best inside containers'
    )
  } else {
    console.log(line(WARN, 'Docker', 'not installed'))
    hint(
      'optional — needed only for the worker sandbox option (`winget install Docker.DockerDesktop` or https://docs.docker.com/get-docker/)'
    )
  }

  console.log(
    `\nData dir: ${dataDir}\nDone: ${failures === 0 ? 'core healthy' : `${failures} core problem(s)`}`
  )
  return failures
}
