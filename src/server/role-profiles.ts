import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { WorkerRole } from '../shared/types.js'
import type { SkillPackage } from './skill-catalog.js'

export type RoleProfileName = 'frontend' | 'backend' | 'reviewer' | 'architect'

export interface RoleProfile {
  model: string
  name: RoleProfileName
  rules: string[]
  skills: string[]
}

const defaults: Record<RoleProfileName, RoleProfile> = {
  frontend: {
    name: 'frontend',
    model: 'claude',
    skills: ['react', 'nextjs', 'typescript'],
    rules: ['write tests', 'follow project style'],
  },
  backend: {
    name: 'backend',
    model: 'codex',
    skills: ['typescript', 'sqlite', 'http-api'],
    rules: [
      'preserve public protocol contracts',
      'add integration coverage for runtime boundaries',
    ],
  },
  reviewer: {
    name: 'reviewer',
    model: 'claude',
    skills: ['code-review', 'security', 'testing'],
    rules: [
      'report evidence and severity',
      'do not change code unless explicitly dispatched to fix it',
    ],
  },
  architect: {
    name: 'architect',
    model: 'codex',
    skills: ['architecture', 'task-planning', 'dependencies'],
    rules: [
      'decompose work into independently verifiable tasks',
      'record decisions in project memory',
    ],
  },
}

const profileForRole = (role: WorkerRole | 'orchestrator'): RoleProfileName => {
  if (role === 'reviewer') return 'reviewer'
  if (role === 'coder') return 'backend'
  return 'architect'
}

const serializeProfile = (profile: RoleProfile) =>
  [
    `name: ${profile.name}`,
    `model: ${profile.model}`,
    '',
    'skills:',
    ...profile.skills.map((skill) => `  - ${skill}`),
    '',
    'rules:',
    ...profile.rules.map((rule) => `  - ${rule}`),
    '',
  ].join('\n')

const parseProfile = (source: string, fallback: RoleProfile): RoleProfile => {
  const result: RoleProfile = { ...fallback, skills: [], rules: [] }
  let collection: 'skills' | 'rules' | null = null

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line === 'skills:' || line === 'rules:') {
      collection = line.slice(0, -1) as 'skills' | 'rules'
      continue
    }
    if (line.startsWith('- ') && collection) {
      result[collection].push(line.slice(2).trim())
      continue
    }
    collection = null
    const match = /^(name|model):\s*(.+)$/.exec(line)
    if (!match) continue
    const value = match[2]
    if (match[1] === 'model' && value) result.model = value.trim()
  }

  return {
    ...result,
    skills: result.skills.length ? result.skills : [...fallback.skills],
    rules: result.rules.length ? result.rules : [...fallback.rules],
  }
}

export const ensureRoleProfiles = (workspacePath: string) => {
  const directory = join(workspacePath, '.gachi', 'agents')
  mkdirSync(directory, { recursive: true })
  for (const profile of Object.values(defaults)) {
    const path = join(directory, `${profile.name}.yaml`)
    if (!existsSync(path)) writeFileSync(path, serializeProfile(profile), 'utf8')
  }
  return directory
}

export const readRoleProfile = (workspacePath: string, role: WorkerRole | 'orchestrator') => {
  const name = profileForRole(role)
  const directory = ensureRoleProfiles(workspacePath)
  return parseProfile(readFileSync(join(directory, `${name}.yaml`), 'utf8'), defaults[name])
}

export const formatRoleProfile = (workspacePath: string, role: WorkerRole | 'orchestrator') => {
  const profile = readRoleProfile(workspacePath, role)
  return [
    `profile: ${profile.name}`,
    `preferred_model: ${profile.model}`,
    `skills: ${profile.skills.join(', ')}`,
    'rules:',
    ...profile.rules.map((rule) => `- ${rule}`),
  ].join('\n')
}

export const installSkillPackage = (
  workspacePath: string,
  role: WorkerRole | 'orchestrator',
  skillPackage: SkillPackage
) => {
  const name = profileForRole(role)
  const directory = ensureRoleProfiles(workspacePath)
  const profile = readRoleProfile(workspacePath, role)
  const merged: RoleProfile = {
    ...profile,
    rules: [...new Set([...profile.rules, ...skillPackage.rules])],
    skills: [...new Set([...profile.skills, ...skillPackage.skills])],
  }
  writeFileSync(join(directory, `${name}.yaml`), serializeProfile(merged), 'utf8')
  return merged
}
