/**
 * Dev probe: exercises the REAL orchestrator session-capture pipeline with the
 * REAL `claude` CLI on this machine. Run manually:
 *
 *   pnpm exec tsx scripts/dev-probe-session-capture.ts
 *
 * Prints, every few seconds: whether a Claude session JSONL appeared for the
 * probe workspace and whether agent_sessions got a row — i.e. exactly the two
 * signals that decide resume-on-restart (S-1).
 */
import { mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createAgentManager } from '../src/server/agent-manager.js'
import { readEnv } from '../src/server/env.js'
import { createRuntimeStore } from '../src/server/runtime-store.js'

const dataDir = mkdtempSync(join(tmpdir(), 'gachi-probe-data-'))
const workspacePath = mkdtempSync(join(tmpdir(), 'gachi-probe-ws-'))
mkdirSync(join(workspacePath, '.git'), { recursive: true }) // isGitWorkspaceRoot true

void (async () => {
  const store = createRuntimeStore({
    agentManager: createAgentManager(),
    dataDir,
  })
  const workspace = store.createWorkspace(workspacePath, 'Probe')
  const orchestratorId = `${workspace.id}:orchestrator`

  store.configureAgentLaunch(workspace.id, orchestratorId, {
    command: 'claude',
    args: [],
  })

  console.log('[probe] starting orchestrator (real claude)...')
  const startedAt = Date.now()
  const run = await store.startAgent(workspace.id, orchestratorId, { gachiPort: '0' } as never)
  console.log(`[probe] run=${run.runId.slice(0, 8)} status=${run.status}`)

  const encoded = workspacePath.replace(/[\\/:\s]/g, '-')
  const projectsDir = join(
    readEnv('CLAUDE_PROJECTS_DIR') ?? join(homedir(), '.claude', 'projects'),
    encoded
  )

  const readSid = (): string | null => {
    try {
      const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
      const row = db
        .prepare('SELECT last_session_id FROM agent_sessions WHERE agent_id = ?')
        .get(orchestratorId) as { last_session_id: string } | undefined
      db.close()
      return row?.last_session_id ?? null
    } catch {
      return null
    }
  }

  const deadline = Date.now() + 150_000
  let lastFileCount = -1
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    let files: Array<{ name: string; kb: number }> = []
    try {
      files = readdirSync(projectsDir)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => ({
          name,
          kb: Math.round(statSync(join(projectsDir, name)).size / 1024),
        }))
    } catch {
      files = []
    }
    if (files.length !== lastFileCount) {
      lastFileCount = files.length
      console.log(
        `[probe] t+${Math.round((Date.now() - startedAt) / 1000)}s jsonl=${files.length}`,
        files.map((file) => `${file.name.slice(0, 8)}:${file.kb}KB`).join(', ')
      )
    }
    const sid = readSid()
    if (sid) {
      console.log(
        `[probe] ✅ CAPTURED session ${sid} at t+${Math.round((Date.now() - startedAt) / 1000)}s`
      )
      break
    }
  }

  const finalSid = readSid()
  if (!finalSid) {
    console.log('[probe] ❌ NO session id captured within window')
    console.log('[probe] hint: check [SESSIONS]/[RUNTIME] lines above from the runtime')
  }

  try {
    store.stopAgentRun(run.runId)
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  await store.close()
  console.log('[probe] done')
})()
