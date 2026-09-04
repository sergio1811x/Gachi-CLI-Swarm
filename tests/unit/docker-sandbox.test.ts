import { describe, expect, test } from 'vitest'

import {
  buildDockerRunLaunch,
  DEFAULT_SANDBOX_IMAGE,
  pickSandboxEnvKeys,
  readSandboxSettings,
} from '../../src/server/docker-sandbox.js'

describe('readSandboxSettings (R5→R10)', () => {
  const settings = (values: Record<string, string>) => ({
    getAppState: (key: string) => (key in values ? { value: values[key] ?? null } : undefined),
  })

  test('defaults to off; orchestrator is never sandboxed', () => {
    expect(readSandboxSettings(settings({ worker_sandbox_ws1: 'docker' }), 'ws1', false)).toEqual({
      image: DEFAULT_SANDBOX_IMAGE,
      mode: 'docker',
    })
    // Orchestrator guard ignores the flag entirely.
    expect(readSandboxSettings(settings({ worker_sandbox_ws1: 'docker' }), 'ws1', true)).toEqual({
      image: null,
      mode: 'off',
    })
    expect(readSandboxSettings(settings({}), 'ws2', false)).toEqual({
      image: null,
      mode: 'off',
    })
  })

  test('custom image is honored', () => {
    const result = readSandboxSettings(
      settings({
        worker_sandbox_ws9: 'docker',
        worker_sandbox_image_ws9: ' ghcr.io/acme/agent:7 ',
      }),
      'ws9',
      false
    )
    expect(result.mode).toBe('docker')
    expect(result.image).toBe('ghcr.io/acme/agent:7')
  })
})

describe('pickSandboxEnvKeys', () => {
  test('forwards provider credentials and brand wiring, nothing else', () => {
    const keys = pickSandboxEnvKeys([
      'PATH',
      'HOME',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'OPENROUTER_API_KEY',
      'GACH_PROJECT_ID',
      'GACH_AGENT_ID',
      'HTTPS_PROXY',
      'no_proxy',
      'AWS_SECRET_ACCESS_KEY',
    ])
    expect(keys).toContain('ANTHROPIC_API_KEY')
    expect(keys).toContain('GACH_PROJECT_ID')
    expect(keys).toContain('HTTPS_PROXY')
    expect(keys).toContain('no_proxy')
    expect(keys).not.toContain('PATH')
    expect(keys).not.toContain('HOME')
    expect(keys).not.toContain('AWS_SECRET_ACCESS_KEY')
  })

  test('deduplicates keys', () => {
    expect(pickSandboxEnvKeys(['Path', 'PATH'])).toEqual([])
  })
})

describe('buildDockerRunLaunch', () => {
  test('wraps the CLI with workspace mount, workdir, env passthrough and -- separator', () => {
    const launch = buildDockerRunLaunch({
      args: ['--resume', 'abc123', '--dangerously-skip-permissions'],
      command: 'claude',
      envKeys: ['ANTHROPIC_API_KEY', 'GACH_PROJECT_ID', 'AWS_SECRET'],
      image: 'node:22-bookworm-slim',
      workspacePath: 'C:\\proj\\demo site',
    })
    expect(launch.command).toBe('docker')
    expect(launch.args).toEqual([
      'run',
      '--rm',
      '-i',
      '--init',
      '-v',
      'C:\\proj\\demo site:/workspace',
      '-w',
      '/workspace',
      '-e',
      'ANTHROPIC_API_KEY',
      '-e',
      'GACH_PROJECT_ID',
      'node:22-bookworm-slim',
      '--',
      'claude',
      '--resume',
      'abc123',
      '--dangerously-skip-permissions',
    ])
  })

  test('falls back to the default image when none given', () => {
    const launch = buildDockerRunLaunch({
      args: [],
      command: 'codex',
      envKeys: [],
      workspacePath: '/home/u/proj',
    })
    expect(launch.args).toContain(DEFAULT_SANDBOX_IMAGE)
    expect(launch.args[launch.args.length - 1]).toBe('codex')
  })

  test('rejects image values that would parse as docker flags', () => {
    expect(() =>
      buildDockerRunLaunch({
        args: [],
        command: 'claude',
        envKeys: [],
        image: '--privileged',
        workspacePath: '/home/u/proj',
      })
    ).toThrow('Invalid sandbox image reference')
    expect(() =>
      buildDockerRunLaunch({
        args: [],
        command: 'claude',
        envKeys: [],
        image: '-v /etc:/host',
        workspacePath: '/home/u/proj',
      })
    ).toThrow('Invalid sandbox image reference')
    // Real references (registry paths, tags, digests) stay accepted.
    expect(() =>
      buildDockerRunLaunch({
        args: [],
        command: 'claude',
        envKeys: [],
        image:
          'ghcr.io/acme/swarm@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        workspacePath: '/home/u/proj',
      })
    ).not.toThrow()
  })
})
