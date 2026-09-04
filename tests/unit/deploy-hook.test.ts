import { describe, expect, test } from 'vitest'

import {
  DEPLOY_HOOK_KEY_PREFIX,
  type DeployHookRunner,
  readDeployHookCommand,
  runDeployHook,
} from '../../src/server/deploy-hook.js'

describe('runDeployHook', () => {
  test('success returns trimmed output and duration', async () => {
    const runner: DeployHookRunner = async () => ({ stdout: 'deployed\n', stderr: '' })
    const result = await runDeployHook('deploy.sh', '/tmp', runner)
    expect(result.ok).toBe(true)
    expect(result.output).toBe('deployed')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('failure captures stderr and message without throwing', async () => {
    const runner: DeployHookRunner = async () => {
      throw Object.assign(new Error('exit code 1'), { stderr: 'boom\n' })
    }
    const result = await runDeployHook('deploy.sh', '/tmp', runner)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('boom')
    expect(result.output).toContain('exit code 1')
  })

  test('timeout is reported in the failure output', async () => {
    const runner: DeployHookRunner = async () => {
      throw Object.assign(new Error('killed'), { killed: true })
    }
    const result = await runDeployHook('deploy.sh', '/tmp', runner, 1234)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('timed out after 1234ms')
  })

  test('output tail is capped', async () => {
    const runner: DeployHookRunner = async () => ({
      stdout: 'x'.repeat(5000),
      stderr: '',
    })
    const result = await runDeployHook('deploy.sh', '/tmp', runner)
    expect(result.output.length).toBeLessThanOrEqual(2000)
  })
})

describe('readDeployHookCommand', () => {
  test('returns command from app-state key', () => {
    const settings = {
      getAppState: (key: string) =>
        key === `${DEPLOY_HOOK_KEY_PREFIX}ws1` ? { value: 'npm run deploy' } : undefined,
    }
    expect(readDeployHookCommand(settings, 'ws1')).toBe('npm run deploy')
  })

  test('blank or missing value means no hook', () => {
    const settings = {
      getAppState: (key: string) =>
        key === `${DEPLOY_HOOK_KEY_PREFIX}ws2` ? { value: '   ' } : undefined,
    }
    expect(readDeployHookCommand(settings, 'ws2')).toBeNull()
    expect(readDeployHookCommand(settings, 'missing')).toBeNull()
  })
})
