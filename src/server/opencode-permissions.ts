import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * OpenCode workers run in bypass-by-design mode (same contract as Claude's
 * `--dangerously-skip-permissions`), but opencode gates folder/file/bash
 * access through its own permission config — without it every task starts
 * with a frozen dialog. This writes a per-workspace allow-all config on
 * first launch; existing user configs are never touched.
 */

const FILE_NAME = 'opencode.json'

const ALLOW_ALL = {
  $schema: 'https://opencode.ai/config.json',
  permission: {
    edit: 'allow',
    bash: { '*': 'allow' },
    webfetch: 'allow',
  },
}

export const ensureOpencodePermissions = (cwd: string): boolean => {
  const target = join(cwd, FILE_NAME)
  if (existsSync(target)) return false // user already has a config — don't touch
  try {
    writeFileSync(target, `${JSON.stringify(ALLOW_ALL, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}
