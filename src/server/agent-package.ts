import { skillCatalog } from './skill-catalog.js'
import type { TeamTemplateInput } from './team-template-store.js'

/**
 * R6 agent package format: a shareable JSON manifest describing a ready team
 * roster (roles + presets) with optional skill references. Built on the
 * existing marketplace каркас — skills are validated against the vendor
 * catalog; installing them stays the per-workspace skills flow.
 *
 * Format `gachi-agent-package` v1:
 * {
 *   "format": "gachi-agent-package",
 *   "version": 1,
 *   "name": "Video crew",
 *   "description": "optional",
 *   "workers": [{ name, role, description, command_preset_id? }],
 *   "skills": ["code-reviewer", …]        // optional
 * }
 */

export const PACKAGE_FORMAT = 'gachi-agent-package'
export const PACKAGE_VERSION = 1

const WORKER_ROLES = new Set(['coder', 'reviewer', 'tester', 'custom'])

export class AgentPackageError extends Error {
  readonly problems: string[]
  readonly missingSkills: string[]

  constructor(message: string, problems: string[] = [], missingSkills: string[] = []) {
    super(message)
    this.name = 'AgentPackageError'
    this.problems = problems
    this.missingSkills = missingSkills
  }
}

interface RawPackageWorker {
  command_preset_id?: unknown
  description?: unknown
  name?: unknown
  role?: unknown
}

export interface AgentPackage {
  description: string | null
  /** Skill ids referenced by the package that are NOT in the vendor catalog. */
  missingSkills: string[]
  name: string
  skills: string[]
  workers: TeamTemplateInput['workers']
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

/** Validates and normalizes a package payload into a template input. */
export const parseAgentPackage = (raw: unknown): AgentPackage => {
  const problems: string[] = []
  if (!isRecord(raw)) throw new AgentPackageError('package must be a JSON object')

  if (raw.format !== PACKAGE_FORMAT) {
    problems.push(`format must be "${PACKAGE_FORMAT}"`)
  }
  if (raw.version !== PACKAGE_VERSION) {
    problems.push(`version must be ${PACKAGE_VERSION}`)
  }

  const name = asString(raw.name)
  if (!name) problems.push('name is required')

  const workersRaw = raw.workers
  if (!Array.isArray(workersRaw) || workersRaw.length === 0) {
    problems.push('workers must be a non-empty array')
  }

  const seenNames = new Set<string>()
  const workers: TeamTemplateInput['workers'] = []
  if (Array.isArray(workersRaw)) {
    for (const [index, entry] of workersRaw.entries()) {
      if (!isRecord(entry)) {
        problems.push(`workers[${index}] must be an object`)
        continue
      }
      const worker = entry as RawPackageWorker
      const workerName = asString(worker.name)
      if (!workerName) {
        problems.push(`workers[${index}].name is required`)
        continue
      }
      if (seenNames.has(workerName)) {
        problems.push(`workers[${index}].name duplicates "${workerName}"`)
        continue
      }
      seenNames.add(workerName)
      const role = asString(worker.role)
      if (!role || !WORKER_ROLES.has(role)) {
        problems.push(`workers[${index}].role must be one of ${[...WORKER_ROLES].join(', ')}`)
        continue
      }
      const presetId = asString(worker.command_preset_id)
      workers.push({
        commandPresetId: presetId,
        description: asString(worker.description) ?? '',
        name: workerName,
        role: role as TeamTemplateInput['workers'][number]['role'],
      })
    }
  }

  const skillsRaw = raw.skills
  let skills: string[] = []
  if (skillsRaw !== undefined) {
    if (!Array.isArray(skillsRaw)) {
      problems.push('skills must be an array of ids')
    } else {
      skills = skillsRaw.filter((id): id is string => typeof id === 'string')
    }
  }
  const knownSkillIds = new Set(skillCatalog.map((skill) => skill.name))
  const missingSkills = skills.filter((skill) => !knownSkillIds.has(skill))

  if (problems.length > 0) {
    throw new AgentPackageError('invalid agent package', problems, missingSkills)
  }
  if (!name || workers.length === 0) {
    // Unreachable when problems were thrown above, kept for type narrowing.
    throw new AgentPackageError('invalid agent package', ['name/workers missing'])
  }

  return { description: asString(raw.description), missingSkills, name, skills, workers }
}

/** Serializes a stored team template into the portable package shape. */
export const serializeTeamTemplateToPackage = (template: {
  name: string
  workers: Array<{
    commandPresetId: string | null
    description: string
    name: string
    role: string
  }>
}): Record<string, unknown> => ({
  format: PACKAGE_FORMAT,
  version: PACKAGE_VERSION,
  name: template.name,
  workers: template.workers.map((worker) => ({
    command_preset_id: worker.commandPresetId,
    description: worker.description,
    name: worker.name,
    role: worker.role,
  })),
})
