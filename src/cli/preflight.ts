import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { evaluateNodeVersion } from './doctor.js'

/**
 * R7 preflight: fast, non-blocking environment checks printed at server start.
 * Warnings only — the server still starts so the UI/doctor can help further.
 */

const exec = promisify(execFile)

export interface PreflightWarning {
  label: string
  fix: string
}

const defaultGitAvailable = async (): Promise<boolean> => {
  try {
    await exec('git', ['--version'], { timeout: 8_000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

export const collectPreflightWarnings = async (
  deps: { gitAvailable?: () => Promise<boolean>; nodeVersion?: string } = {}
): Promise<PreflightWarning[]> => {
  const warnings: PreflightWarning[] = []

  const node = evaluateNodeVersion(deps.nodeVersion ?? process.version)
  if (!node.ok && node.fix) {
    warnings.push({ fix: node.fix, label: `Node ${node.detail}` })
  }

  const gitOk = await (deps.gitAvailable ?? defaultGitAvailable)()
  if (!gitOk) {
    warnings.push({
      fix: 'install Git (https://git-scm.com or `winget install --id Git.Git`), then reopen the terminal',
      label: 'Git not found',
    })
  }

  return warnings
}
