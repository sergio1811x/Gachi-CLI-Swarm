import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import {
  ensureRoleProfiles,
  formatRoleProfile,
  installSkillPackage,
  readRoleProfile,
} from '../../src/server/role-profiles.js'
import { findSkillPackage } from '../../src/server/skill-catalog.js'

const directories: string[] = []
const workspace = () => {
  const path = mkdtempSync(join(tmpdir(), 'gachi-role-profile-'))
  directories.push(path)
  return path
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

describe('role profiles', () => {
  test('creates the portable YAML profile set and maps coder to backend', () => {
    const path = workspace()
    const directory = ensureRoleProfiles(path)

    expect(readFileSync(join(directory, 'frontend.yaml'), 'utf8')).toContain('skills:')
    expect(readRoleProfile(path, 'coder')).toMatchObject({ name: 'backend', model: 'codex' })
  })

  test('uses workspace-local profile edits in startup context', () => {
    const path = workspace()
    const directory = ensureRoleProfiles(path)
    writeFileSync(
      join(directory, 'reviewer.yaml'),
      'name: reviewer\nmodel: gemini\nskills:\n  - security\nrules:\n  - require a threat model\n'
    )

    expect(formatRoleProfile(path, 'reviewer')).toContain('preferred_model: gemini')
    expect(formatRoleProfile(path, 'reviewer')).toContain('- require a threat model')
  })

  test('installs a catalog package into the workspace profile without duplicates', () => {
    const path = workspace()
    const skillPackage = findSkillPackage('Security Auditor')
    expect(skillPackage).toBeDefined()
    if (!skillPackage) throw new Error('Security Auditor is missing from the skill catalog')

    installSkillPackage(path, 'reviewer', skillPackage)
    installSkillPackage(path, 'reviewer', skillPackage)

    const profile = readRoleProfile(path, 'reviewer')
    expect(profile.skills).toContain('threat-modeling')
    expect(profile.rules.filter((rule) => rule === 'report evidence and severity')).toHaveLength(1)
  })
})
