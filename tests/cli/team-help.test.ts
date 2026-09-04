import { afterEach, describe, expect, test, vi } from 'vitest'

import { runTeamCommand } from '../../src/cli/team.js'
import { IS_WINDOWS } from '../helpers/platform.js'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
})

describe.skipIf(IS_WINDOWS)('team cli help', () => {
  test('prints usage without requiring Gachi agent environment', async () => {
    process.env = {}
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(runTeamCommand(['--help'])).resolves.toBeUndefined()

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(output).toContain('Usage:')
    expect(output).toContain('team list')
    expect(output).toContain('team send <worker-name> "<task>"')
    expect(output).toContain('team cancel (--dispatch <dispatch-id>|--task <task-id>) "<reason>"')
    expect(output).toContain('team task-delete <task-id> ["<reason>"]')
    expect(output).toContain('team report "<result>"')
    expect(output).toContain('team status "<current status>"')
    expect(output).not.toContain('--success')
    expect(output).not.toContain('--failed')
  })

  test('team report warns when Gachi CLI Swarm records the report but cannot live-deliver it', async () => {
    process.env = {
      GACH_AGENT_ID: 'worker-1',
      GACH_AGENT_TOKEN: 'token-1',
      GACH_PORT: '12345',
      GACH_PROJECT_ID: 'workspace-1',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              dispatch_id: 'dispatch-1',
              forward_error: 'No active run for agent: workspace-1:orchestrator',
              forwarded: false,
              ok: true,
            }),
            { headers: { 'content-type': 'application/json' }, status: 202 }
          )
      )
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runTeamCommand(['report', 'Done'])

    expect(errorSpy).toHaveBeenCalledWith(
      'Gachi CLI Swarm recorded the report, but could not deliver it to Orchestrator in real time: No active run for agent: workspace-1:orchestrator'
    )
  })
})
