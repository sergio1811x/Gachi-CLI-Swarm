import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readEnv } from '../server/env.js'

const REQUIRED_ENV_KEYS = ['PORT', 'PROJECT_ID', 'AGENT_ID', 'AGENT_TOKEN'] as const

type GachiEnvKey = (typeof REQUIRED_ENV_KEYS)[number]

interface GachiEnv {
  PORT: string
  PROJECT_ID: string
  AGENT_ID: string
  AGENT_TOKEN: string
}

const TEAM_USAGE = [
  'Usage:',
  '  team list',
  '  team ps',
  '  team note <worker-name> "<text>"',
  '  team send <worker-name> "<task>"',
  '  team engine <worker-name-or-orchestrator> <codex|agy|claude|opencode>',
  '  team model <worker-name-or-orchestrator> "<model-id>"',
  '  team accept [--dispatch <dispatch-id>] [--task <task-id>] ["<approval note>"]',
  '  team rework [--dispatch <dispatch-id>] [--task <task-id>] "<rework feedback>"',
  '  team cancel (--dispatch <dispatch-id>|--task <task-id>) "<reason>"',
  '  team task-delete <task-id> ["<reason>"]',
  '  team tasks-cleanup --stale-hours <hours> [--dry-run] [--apply] [--delete]',
  '  team report --file <path> [--dispatch <dispatch-id>]',
  '  team report "<result>" [--dispatch <dispatch-id>] [--artifact <path>]',
  '  team report --stdin [--dispatch <dispatch-id>] [--artifact <path>]',
  '  team resume ["<reason>"]   (orchestrator-only: clear a dispatch pause / error-budget breaker)',
  '  team status "<current status>" [--artifact <path>]',
  '  team status --stdin [--artifact <path>]',
  '  team request "<command>" [--dispatch <dispatch-id>] ["<reason>"]',
  '  team events [--limit <n>] [--since <epoch-ms>]',
  '  team worker add <name> [role] [--preset <id>] [--no-start]   (with --preset: creates AND starts in one command)',
  '  team worker start|stop|pause|resume|compact|rm <name>',
  '  team worker describe <name> "<description>"   (update the worker\'s persistent specialization note)',
  '  team worker restart-all-crashed',
  '  team pr status',
  '  team pr create (--branch <name>|--task <task-id>) [--title "<t>"] [--base <b>] ["<body>"]',
  '',
  'Flags can appear in any order. Use --stdin to pipe long bodies and avoid shell-escaping issues.',
  "Use a quoted heredoc (<<'EOF') so $vars, backticks, and command substitutions stay literal:",
  "  team report --stdin --dispatch <id> <<'EOF'",
  '  ... long report ...',
  '  EOF',
  '',
  'For role rules, workflow, and recovery instructions, see .gachi/PROTOCOL.md',
].join('\n')

const getGachiEnv = (): GachiEnv => {
  const values = Object.fromEntries(REQUIRED_ENV_KEYS.map((key) => [key, readEnv(key)])) as Partial<
    Record<GachiEnvKey, string>
  >

  if (REQUIRED_ENV_KEYS.some((key) => !values[key])) {
    throw new Error('Missing required environment variables')
  }

  return values as GachiEnv
}

const getBaseUrl = (env: GachiEnv) => `http://127.0.0.1:${env.PORT}`

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const describeFetchError = (baseUrl: string, error: unknown) => {
  const cause =
    error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : ''
  const message = error instanceof Error ? error.message : String(error)
  return `Failed to reach the runtime at ${baseUrl}: ${message}${cause}. Check GACH_PORT and make sure the runtime is still running.`
}

const fetchRuntime = async (baseUrl: string, path: string, init: RequestInit) => {
  try {
    return await fetch(`${baseUrl}${path}`, init)
  } catch (error) {
    throw new Error(describeFetchError(baseUrl, error))
  }
}

const readHttpErrorDetail = async (response: Response) => {
  const text = await response.text().catch(() => '')
  const trimmed = text.trim()
  if (!trimmed) return ''

  try {
    const body = JSON.parse(trimmed) as { error?: unknown }
    if (typeof body.error === 'string' && body.error.trim()) {
      return body.error.trim()
    }
  } catch {
    // Non-JSON responses still carry useful diagnostics in their text body.
  }

  return trimmed
}

const throwHttpError = async (response: Response): Promise<never> => {
  const detail = await readHttpErrorDetail(response)
  throw new Error(
    detail
      ? `Request failed with status ${response.status}: ${detail}`
      : `Request failed with status ${response.status}`
  )
}

const postJson = async (baseUrl: string, path: string, body: unknown) => {
  const response = await fetchRuntime(baseUrl, path, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    await throwHttpError(response)
  }

  return response
}

interface TeamReportResponse {
  dispatch_id: string | null
  forward_error?: string | null
  forwarded?: boolean
  ok: true
}

interface ParsedCancelArgs {
  dispatchId: string | undefined
  taskId: string | undefined
  reason: string
}

const REPORT_USAGE =
  'Usage: team report (<result> | --file <path> | --stdin) [--dispatch <dispatch-id>] [--artifact <path>]'
const STATUS_USAGE =
  'Usage: team status (<current status> | --file <path> | --stdin) [--artifact <path>]'
const CANCEL_USAGE = 'Usage: team cancel (--dispatch <dispatch-id>|--task <task-id>) <reason>'

const usageFor = (command: string) => (command === 'status' ? STATUS_USAGE : REPORT_USAGE)

const withUsage = (message: string, command: string) => `${message}\n\n${usageFor(command)}`

export interface ParsedReportArgs {
  artifacts: string[]
  dispatchId: string | undefined
  result: string | null
  useStdin: boolean
}

export const parseReportArgs = (args: string[], command = 'report'): ParsedReportArgs => {
  const positionals: string[] = []
  const artifacts: string[] = []
  let dispatchId: string | undefined
  let useStdin = false
  let filePath: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    // Backward-compatible no-op: reports are interpreted from their text.
    if (arg === '--success' || arg === '--failed') continue

    if (arg === '--stdin') {
      useStdin = true
      continue
    }

    if (arg === '--file') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(withUsage('--file requires a path', command))
      }
      filePath = next
      if (!artifacts.includes(next)) {
        artifacts.push(next)
      }
      index += 1
      continue
    }

    if (arg === '--artifact') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(withUsage('--artifact requires a value', command))
      }
      if (!artifacts.includes(next)) {
        artifacts.push(next)
      }
      index += 1
      continue
    }

    if (arg === '--dispatch') {
      if (command === 'status') {
        throw new Error(
          withUsage(
            'team status does not accept --dispatch; use team report for assigned work',
            command
          )
        )
      }
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(withUsage('--dispatch requires a value', command))
      }
      dispatchId = next
      index += 1
      continue
    }

    if (arg.startsWith('--')) {
      throw new Error(withUsage(`Unknown argument: ${arg}`, command))
    }

    positionals.push(arg)
  }

  if (useStdin && (positionals.length > 0 || filePath)) {
    throw new Error(
      withUsage(
        '--stdin is mutually exclusive with positional text or --file; pass body via one method only',
        command
      )
    )
  }

  let finalResult: string | null = null

  if (filePath) {
    if (!existsSync(filePath)) {
      throw new Error(withUsage(`File not found: ${filePath}`, command))
    }
    finalResult = readFileSync(filePath, 'utf8')
  } else if (!useStdin) {
    if (positionals.length === 0) {
      const label = command === 'status' ? '<current status>' : '<result>'
      throw new Error(withUsage(`Missing ${label} (or pass --file <path> or --stdin)`, command))
    }
    // Если shell разбил JSON или аргумент на несколько слов — объединяем их без потери данных
    finalResult = positionals.join(' ')
  }

  return { result: finalResult, artifacts, dispatchId, useStdin }
}

export const parseCancelArgs = (args: string[]): ParsedCancelArgs => {
  const positionals: string[] = []
  let dispatchId: string | undefined
  let taskId: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--dispatch') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--dispatch requires a value\n\n${CANCEL_USAGE}`)
      }
      dispatchId = next
      index += 1
      continue
    }

    if (arg === '--task') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--task requires a value\n\n${CANCEL_USAGE}`)
      }
      taskId = next
      index += 1
      continue
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}\n\n${CANCEL_USAGE}`)
    }

    positionals.push(arg)
  }

  if (!dispatchId && !taskId) {
    throw new Error(`Missing --dispatch <dispatch-id> or --task <task-id>\n\n${CANCEL_USAGE}`)
  }
  if (dispatchId && taskId) {
    throw new Error(`Pass either --dispatch or --task, not both\n\n${CANCEL_USAGE}`)
  }
  if (positionals.length === 0) {
    throw new Error(`Missing <reason>\n\n${CANCEL_USAGE}`)
  }

  const reason = positionals.join(' ').trim()
  if (!reason) {
    throw new Error(`Missing <reason>\n\n${CANCEL_USAGE}`)
  }

  return { dispatchId, taskId, reason }
}

export interface ParsedAcceptArgs {
  dispatchId: string | undefined
  taskId: string | undefined
  note: string | undefined
}

export const parseAcceptArgs = (args: string[], command = 'accept'): ParsedAcceptArgs => {
  const positionals: string[] = []
  let dispatchId: string | undefined
  let taskId: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--dispatch') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(
          `--dispatch requires a value\n\nUsage: team ${command} [--dispatch <id>] [--task <id>] ["<note>"]`
        )
      }
      dispatchId = next
      index += 1
      continue
    }

    if (arg === '--task') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(
          `--task requires a value\n\nUsage: team ${command} [--dispatch <id>] [--task <id>] ["<note>"]`
        )
      }
      taskId = next
      index += 1
      continue
    }

    if (arg.startsWith('--')) {
      throw new Error(
        `Unknown argument: ${arg}\n\nUsage: team ${command} [--dispatch <id>] [--task <id>] ["<note>"]`
      )
    }

    positionals.push(arg)
  }

  const note = positionals.join(' ').trim() || undefined
  return { dispatchId, taskId, note }
}

export interface ParsedReworkArgs {
  dispatchId: string | undefined
  taskId: string | undefined
  feedback: string
}

export const parseReworkArgs = (args: string[], command = 'rework'): ParsedReworkArgs => {
  const positionals: string[] = []
  let dispatchId: string | undefined
  let taskId: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--dispatch') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(
          `--dispatch requires a value\n\nUsage: team ${command} [--dispatch <id>] [--task <id>] "<feedback>"`
        )
      }
      dispatchId = next
      index += 1
      continue
    }

    if (arg === '--task') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(
          `--task requires a value\n\nUsage: team ${command} [--dispatch <id>] [--task <id>] "<feedback>"`
        )
      }
      taskId = next
      index += 1
      continue
    }

    if (arg.startsWith('--')) {
      throw new Error(
        `Unknown argument: ${arg}\n\nUsage: team ${command} [--dispatch <id>] [--task <id>] "<feedback>"`
      )
    }

    positionals.push(arg)
  }

  const feedback = positionals.join(' ').trim()
  if (!feedback) {
    throw new Error(
      `Missing rework feedback\n\nUsage: team ${command} [--dispatch <id>] [--task <id>] "<feedback>"`
    )
  }

  return { dispatchId, taskId, feedback }
}

export const readStdinToString = async (command = 'report'): Promise<string> => {
  if (process.stdin.isTTY) {
    throw new Error(
      withUsage(
        '--stdin requires piped input, but stdin is a TTY. Did you forget to pipe content in?',
        command
      )
    )
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const content = Buffer.concat(chunks).toString('utf8')
  if (!content.trim()) {
    throw new Error(withUsage('--stdin received empty input', command))
  }
  return content
}

export const runTeamCommand = async (argv: string[]) => {
  const [command, ...args] = argv

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(TEAM_USAGE)
    return
  }

  if (command === 'events') {
    let limit: number | undefined
    let since: number | undefined
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === undefined) continue
      if (arg === '--limit') {
        const next = args[index + 1]
        const parsed = Number(next)
        if (next === undefined || !Number.isInteger(parsed) || parsed <= 0) {
          throw new Error('Usage: team events [--limit <n>] [--since <epoch-ms>]')
        }
        limit = parsed
        index += 1
      } else if (arg === '--since') {
        const next = args[index + 1]
        const parsed = Number(next)
        if (next === undefined || !Number.isFinite(parsed)) {
          throw new Error('Usage: team events [--limit <n>] [--since <epoch-ms>]')
        }
        since = parsed
        index += 1
      } else if (arg.startsWith('--')) {
        throw new Error('Usage: team events [--limit <n>] [--since <epoch-ms>]')
      }
    }

    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const query = new URLSearchParams({
      project_id: env.PROJECT_ID,
      agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
    })
    if (limit !== undefined) query.set('limit', String(limit))
    if (since !== undefined) query.set('since', String(since))

    const response = await fetchRuntime(baseUrl, `/api/team/events?${query.toString()}`, {
      method: 'GET',
    })
    if (!response.ok) {
      await throwHttpError(response)
    }
    const payload = (await response.json()) as { events: unknown[]; ok: true }
    console.log(JSON.stringify(payload.events))
    return
  }

  if (command === 'ps') {
    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const response = await fetchRuntime(
      baseUrl,
      `/api/workspaces/${env.PROJECT_ID}/team?active_only=1`,
      {
        method: 'GET',
        headers: {
          'x-gachi-agent-id': env.AGENT_ID,
          'x-gachi-agent-token': env.AGENT_TOKEN,
        },
      }
    )

    if (!response.ok) {
      await throwHttpError(response)
    }

    const workers = (await response.json()) as Array<{
      name: string
      status: string
      paused?: boolean
      current_task_id?: string | null
      current_task_title?: string | null
    }>
    if (workers.length === 0) {
      console.log('No active runs.')
      return
    }
    for (const worker of workers) {
      const task = worker.current_task_id
        ? `${worker.current_task_id}${worker.current_task_title ? ` ${worker.current_task_title}` : ''}`
        : '-'
      console.log(`${worker.name} | ${worker.status}${worker.paused ? ' (paused)' : ''} | ${task}`)
    }
    return
  }

  if (command === 'list') {
    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const response = await fetchRuntime(baseUrl, `/api/workspaces/${env.PROJECT_ID}/team`, {
      method: 'GET',
      headers: {
        'x-gachi-agent-id': env.AGENT_ID,
        'x-gachi-agent-token': env.AGENT_TOKEN,
      },
    })

    if (!response.ok) {
      await throwHttpError(response)
    }

    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'send') {
    const [workerName, ...taskParts] = args
    const task = taskParts.join(' ').trim()
    if (!workerName || !task || uuidPattern.test(workerName)) {
      throw new Error(
        'Usage: team send <worker-name> <task>\n' +
          'Quote worker names that contain spaces: team send "Theme Scout A" "fix the login flow"'
      )
    }

    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/send', {
      gachi_port: readEnv('PORT'),
      project_id: env.PROJECT_ID,
      from_agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
      to: workerName,
      text: task,
    })
    const payload = (await response.json()) as { dispatch_paused?: boolean; warning?: string }
    // stderr keeps stdout machine-parseable for the orchestrator.
    if (payload.dispatch_paused) {
      console.warn(`[gachi] ${payload.warning ?? 'dispatch is paused for this workspace'}`)
    }
    console.log(JSON.stringify(payload))
    return
  }

  if (command === 'cancel') {
    const cancel = parseCancelArgs(args)
    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    await postJson(baseUrl, '/api/team/cancel', {
      ...(cancel.dispatchId ? { dispatch_id: cancel.dispatchId } : {}),
      ...(cancel.taskId ? { task_id: cancel.taskId } : {}),
      project_id: env.PROJECT_ID,
      from_agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
      reason: cancel.reason,
    })
    return
  }

  if (command === 'task-delete') {
    const [taskId, ...reasonParts] = args
    if (!taskId || taskId.startsWith('--')) {
      throw new Error('Usage: team task-delete <task-id> ["<reason>"]')
    }
    const reason = reasonParts.join(' ').trim() || 'deleted via team task-delete'
    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/task-delete', {
      task_id: taskId,
      project_id: env.PROJECT_ID,
      from_agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
      reason,
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'tasks-cleanup') {
    let staleHours: number | undefined
    let dryRun = true
    let applyDelete = false
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === '--stale-hours') {
        const raw = args[index + 1]
        const parsed = Number(raw)
        if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
          throw new Error('--stale-hours requires a positive number of hours')
        }
        staleHours = parsed
        index += 1
      } else if (arg === '--dry-run') {
        dryRun = true
      } else if (arg === '--delete') {
        applyDelete = true
        dryRun = false
      } else if (arg === '--apply') {
        dryRun = false
      } else {
        throw new Error(
          'Usage: team tasks-cleanup --stale-hours <hours> [--dry-run] [--apply] [--delete]'
        )
      }
    }
    if (staleHours === undefined) {
      throw new Error(
        'Usage: team tasks-cleanup --stale-hours <hours> [--dry-run] [--apply] [--delete]'
      )
    }

    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/tasks/cleanup', {
      project_id: env.PROJECT_ID,
      from_agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
      stale_hours: staleHours,
      dry_run: dryRun,
      delete: applyDelete,
    })
    const payload = (await response.json()) as {
      ok?: boolean
      matched?: number
      dry_run?: boolean
      delete?: boolean
      tasks?: Array<{ id: string; title: string; status: string; assigned_agent_id: string | null }>
    }
    if (!response.ok) {
      await throwHttpError(response)
    }
    const mode = payload.delete ? 'delete' : 'unbind'
    const scope = payload.dry_run ? 'DRY-RUN (nothing changed)' : `APPLIED (${mode})`
    console.log(`tasks-cleanup ${scope}: matched ${payload.matched ?? 0} stale card(s)`)
    for (const task of payload.tasks ?? []) {
      const assignee = task.assigned_agent_id ? ` @${task.assigned_agent_id.split(':').pop()}` : ''
      console.log(`  ${task.id} [${task.status}]${assignee} ${task.title}`)
    }
    return
  }

  if (command === 'status') {
    const report = parseReportArgs(args, 'status')
    const body = report.useStdin ? await readStdinToString('status') : (report.result ?? '')

    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/status', {
      project_id: env.PROJECT_ID,
      from_agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
      result: body,
      artifacts: report.artifacts,
    })
    const payload = (await response.json()) as TeamReportResponse
    if (payload.forwarded === false && payload.forward_error) {
      console.error(
        `Recorded the status update, but could not deliver it to Orchestrator in real time: ${payload.forward_error}`
      )
    }
    return
  }

  if (command === 'report') {
    const report = parseReportArgs(args)
    const body = report.useStdin ? await readStdinToString('report') : (report.result ?? '')

    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/report', {
      ...(report.dispatchId ? { dispatch_id: report.dispatchId } : {}),
      project_id: env.PROJECT_ID,
      from_agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
      result: body,
      artifacts: report.artifacts,
    })
    const payload = (await response.json()) as TeamReportResponse
    if (payload.forwarded === false && payload.forward_error) {
      console.error(
        `Recorded the report, but could not deliver it to Orchestrator in real time: ${payload.forward_error}`
      )
    }
    return
  }

  if (command === 'engine') {
    const [target, engine] = args
    if (!target || !engine) {
      throw new Error(
        'Usage: team engine <worker-name-or-orchestrator> <codex|agy|claude|opencode>'
      )
    }

    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/engine', {
      project_id: env.PROJECT_ID,
      from_agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
      target,
      engine,
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'model') {
    const [target, model] = args
    if (!target || !model) {
      throw new Error('Usage: team model <worker-name-or-orchestrator> "<model-id>"')
    }
    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/model', {
      project_id: env.PROJECT_ID,
      from_agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
      target,
      model,
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'accept' || command === 'approve') {
    const accept = parseAcceptArgs(args, command)
    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/accept', {
      project_id: env.PROJECT_ID,
      from_agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
      ...(accept.dispatchId ? { dispatch_id: accept.dispatchId } : {}),
      ...(accept.taskId ? { task_id: accept.taskId } : {}),
      ...(accept.note ? { note: accept.note } : {}),
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'rework' || command === 'reject') {
    const rework = parseReworkArgs(args, command)
    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/rework', {
      project_id: env.PROJECT_ID,
      from_agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
      feedback: rework.feedback,
      ...(rework.dispatchId ? { dispatch_id: rework.dispatchId } : {}),
      ...(rework.taskId ? { task_id: rework.taskId } : {}),
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'request') {
    // Permission request: `team request "<command>" [--dispatch <id>] ["<reason>"]`
    const positional: string[] = []
    let dispatchId: string | undefined
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === '--dispatch') {
        const next = args[index + 1]
        if (!next) throw new Error('Usage: team request "<command>" [--dispatch <id>] ["<reason>"]')
        dispatchId = next
        index += 1
        continue
      }
      if (arg !== undefined) positional.push(arg)
    }
    const commandText = positional[0]
    const reason = positional.slice(1).join(' ').trim() || undefined
    if (!commandText) {
      throw new Error('Usage: team request "<command>" [--dispatch <id>] ["<reason>"]')
    }

    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/request', {
      project_id: env.PROJECT_ID,
      from_agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
      command: commandText,
      ...(reason ? { reason } : {}),
      ...(dispatchId ? { dispatch_id: dispatchId } : {}),
    })
    const payload = (await response.json()) as {
      ok?: boolean
      request_id?: string
      error?: string
      retry_after_ms?: number
    }
    if (response.status === 429 || payload.ok === false) {
      console.error(
        `${payload.error ?? 'Permission request rejected'}${
          payload.retry_after_ms ? ` (retry in ${Math.ceil(payload.retry_after_ms / 1000)}s)` : ''
        }`
      )
      process.exitCode = 1
      return
    }
    console.log(
      JSON.stringify({
        ok: true,
        message: 'Permission requested. A human must approve or deny it.',
        ...payload,
      })
    )
    return
  }

  if (command === 'resume') {
    // Orchestrator-only: clear a workspace dispatch pause (error-budget
    // breaker) without leaving the CLI. The optional reason lands in the log.
    const reason = args.join(' ').trim()
    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/dispatch-resume', {
      project_id: env.PROJECT_ID,
      from_agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
      ...(reason ? { reason } : {}),
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'worker') {
    // Workforce management (orchestrator-only):
    //   team worker add <name> [role] [--preset <id>] [--no-start]
    //   team worker start|stop|pause|resume|compact|rm <name>
    //   team worker stop <name> --cancel-task   (cancel the in-flight card
    //     instead of requeueing it — unblocks a hung worker for a fresh send)
    //   team worker describe <name> "<description>"
    //   team worker restart-all-crashed
    const sub = args[0]
    const name = args[1]
    const needsName = sub !== 'restart-all-crashed'
    if (
      !sub ||
      (needsName && !name) ||
      ![
        'add',
        'start',
        'stop',
        'pause',
        'resume',
        'compact',
        'describe',
        'restart-all-crashed',
        'rm',
      ].includes(sub)
    ) {
      throw new Error(
        'Usage: team worker <add|start|stop|pause|resume|compact|rm> <name> [role] [--preset <id>]\n' +
          '       team worker stop <name> --cancel-task  (cancel the stuck card instead of requeueing)\n' +
          '       team worker describe <name> "<description>"\n' +
          '       team worker restart-all-crashed\n' +
          '       add --preset <id> creates AND starts the worker; without a preset, run\n' +
          '       `team engine <name> <engine>` first or start will fail with a hint.'
      )
    }
    // Argument validation runs before the env lookup so usage errors surface
    // even when the CLI is invoked outside an agent session.
    const describeText = sub === 'describe' ? args.slice(2).join(' ').trim() : ''
    if (sub === 'describe' && !describeText) {
      throw new Error(
        'Usage: team worker describe <name> "<description>"\n' +
          "The description is the worker's persistent specialization note — it is\n" +
          'injected into every dispatch prompt, so keep engine/model specifics current.'
      )
    }
    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const payload: Record<string, unknown> = {
      project_id: env.PROJECT_ID,
      from_agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
      name,
    }
    if (sub === 'describe') {
      payload.description = describeText
    }
    if (sub === 'stop' && args.includes('--cancel-task')) {
      payload.cancel_task = true
    }
    if (sub === 'add') {
      const extraFlags: Record<string, string> = {}
      const extraPositionals: string[] = []
      for (let i = 2; i < args.length; i += 1) {
        if (args[i] === '--preset') {
          extraFlags.preset = args[i + 1] ?? ''
          i += 1
        } else if (args[i] === '--no-start') {
          extraFlags.noStart = '1'
        } else {
          extraPositionals.push(args[i] ?? '')
        }
      }
      if (extraPositionals.length > 1) {
        // The shell splits unquoted multi-word names — the tail used to be
        // silently swallowed as role/dropped, mis-configuring the worker.
        throw new Error(
          'Too many arguments — quote worker names that contain spaces:\n' +
            '  team worker add "<full name>" [role] [--preset <id>]'
        )
      }
      payload.role = extraPositionals[0] || 'coder'
      if (extraFlags.preset) payload.preset = extraFlags.preset
      payload.autostart = extraFlags.noStart !== '1'
    }
    const response = await postJson(baseUrl, `/api/team/worker/${sub}`, payload)
    const body = (await response.json()) as Record<string, unknown>
    console.log(JSON.stringify({ ok: response.ok, ...body }))
    return
  }

  if (command === 'note') {
    // Orchestrator-only raw note into a worker's PTY: no card, no dispatch.
    //   team note <name> "<text>"
    const name = args[0]
    const text = args.slice(1).join(' ').trim()
    if (!name || !text) {
      throw new Error('Usage: team note <worker-name> "<text>"')
    }
    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/worker/note', {
      project_id: env.PROJECT_ID,
      from_agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
      name,
      text,
    })
    const body = (await response.json()) as Record<string, unknown>
    console.log(JSON.stringify({ ok: response.ok, ...body }))
    return
  }

  if (command === 'pr') {
    // GitHub PR flow (orchestrator-only):
    //   team pr status — gh availability + open PRs for the workspace repo.
    //   team pr create (--branch <name>|--task <task-id>) [--title] [--base] ["<body>"]
    const sub = args[0]
    if (!sub || !['status', 'create'].includes(sub)) {
      throw new Error('Usage: team pr <status|create> [--branch <name>|--task <id>] ...')
    }
    const env = getGachiEnv()
    const baseUrl = getBaseUrl(env)
    const flags: Record<string, string> = {}
    let positional = ''
    for (let i = 1; i < args.length; i += 1) {
      if (
        args[i] === '--branch' ||
        args[i] === '--task' ||
        args[i] === '--title' ||
        args[i] === '--base'
      ) {
        const flagName = args[i]?.slice(2) ?? ''
        flags[flagName] = args[i + 1] ?? ''
        i += 1
      } else if (!positional) {
        positional = args[i] ?? ''
      }
    }
    if (sub === 'status') {
      const response = await postJson(baseUrl, '/api/team/pr/status', {
        project_id: env.PROJECT_ID,
        from_agent_id: env.AGENT_ID,
        token: env.AGENT_TOKEN,
      })
      const body = (await response.json()) as Record<string, unknown>
      console.log(JSON.stringify({ ok: response.ok, ...body }))
      return
    }
    // sub === 'create'
    if (!flags.branch && !flags.task) {
      throw new Error('team pr create requires --branch <name> or --task <task-id>')
    }
    const payload: Record<string, unknown> = {
      project_id: env.PROJECT_ID,
      from_agent_id: env.AGENT_ID,
      token: env.AGENT_TOKEN,
    }
    if (flags.branch) payload.branch = flags.branch
    if (flags.task) payload.task_id = flags.task
    if (flags.title) payload.title = flags.title
    if (flags.base) payload.base = flags.base
    if (positional) payload.body = positional
    const response = await fetchRuntime(baseUrl, '/api/team/pr/create', {
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const body = (await response.json()) as Record<string, unknown>
    console.log(JSON.stringify({ ok: response.ok, ...body }))
    return
  }

  throw new Error('Unsupported team command')
}

const isMainModule = process.argv[1]
  ? fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  : false

if (isMainModule) {
  void runTeamCommand(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
