import { resolveCommandPath } from './agent-command-resolver.js'
import {
  AgentPackageError,
  parseAgentPackage,
  serializeTeamTemplateToPackage,
} from './agent-package.js'
import type { CommandPresetInput } from './command-preset-store.js'
import { BadRequestError } from './http-errors.js'
import type { RoleTemplateInput } from './role-template-store.js'
import {
  getRequiredParam,
  jsonBodyValidator,
  parseJsonBody,
  route,
  sendJson,
} from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import type { SessionIdCaptureConfig } from './session-capture.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

type CommandPresetBody = {
  display_name: string
  command: string
  args: string[]
  env: Record<string, string>
  resume_args_template: string | null
  session_id_capture: SessionIdCaptureConfig | null
  yolo_args_template: string[] | null
}

type RoleTemplateBody = {
  name: string
  role_type: 'orchestrator' | 'coder' | 'reviewer' | 'tester' | 'custom'
  description: string
  default_command: string
  default_args: string[]
  default_env: Record<string, string>
}

type TeamTemplateWorkerBody = {
  name: string
  role: 'coder' | 'reviewer' | 'tester' | 'custom'
  description: string
  command_preset_id: string | null
}

type TeamTemplateBody = {
  name: string
  workers: TeamTemplateWorkerBody[]
}

const serializeCommandPreset = (preset: {
  id: string
  displayName: string
  command: string
  args: string[]
  env: Record<string, string>
  resumeArgsTemplate: string | null
  sessionIdCapture: SessionIdCaptureConfig | null
  yoloArgsTemplate: string[] | null
  isBuiltin: boolean
}) => {
  let available = false
  try {
    if (preset.command.trim()) {
      resolveCommandPath(preset.command, process.cwd(), { ...process.env, ...preset.env })
      available = true
    }
  } catch {
    available = false
  }

  return {
    id: preset.id,
    display_name: preset.displayName,
    command: preset.command,
    args: preset.args,
    env: preset.env,
    resume_args_template: preset.resumeArgsTemplate,
    session_id_capture: preset.sessionIdCapture,
    yolo_args_template: preset.yoloArgsTemplate,
    is_builtin: preset.isBuiltin,
    available,
  }
}

const serializeRoleTemplate = (template: {
  id: string
  name: string
  roleType: string
  description: string
  defaultCommand: string
  defaultArgs: string[]
  defaultEnv: Record<string, string>
  isBuiltin: boolean
}) => ({
  id: template.id,
  name: template.name,
  role_type: template.roleType,
  description: template.description,
  default_command: template.defaultCommand,
  default_args: template.defaultArgs,
  default_env: template.defaultEnv,
  is_builtin: template.isBuiltin,
})

const serializeTeamTemplate = (template: {
  id: string
  name: string
  workers: Array<{
    name: string
    role: string
    description: string
    commandPresetId: string | null
  }>
}) => ({
  id: template.id,
  name: template.name,
  workers: template.workers.map((worker) => ({
    name: worker.name,
    role: worker.role,
    description: worker.description,
    command_preset_id: worker.commandPresetId,
  })),
})

const readCommandPresetBody = async (
  request: Parameters<RouteDefinition['handler']>[0]['request']
): Promise<Partial<CommandPresetInput>> => {
  const body = await parseJsonBody<Partial<CommandPresetBody>>(request, (raw) => {
    const value = jsonBodyValidator.object(raw)
    const result: Record<string, unknown> = {
      ...(value.session_id_capture !== undefined
        ? { session_id_capture: value.session_id_capture }
        : {}),
    }
    if (value.display_name !== undefined) {
      result.display_name = jsonBodyValidator.string(value.display_name, 'display_name')
    }
    if (value.command !== undefined) {
      result.command = jsonBodyValidator.string(value.command, 'command')
    }
    if (value.args !== undefined) {
      result.args = jsonBodyValidator.optionalStringArray(value.args, 'args')
    }
    if (value.env !== undefined) {
      result.env = jsonBodyValidator.optionalRecord(value.env, 'env')
    }
    if (value.resume_args_template !== undefined) {
      result.resume_args_template = jsonBodyValidator.nullableString(
        value.resume_args_template,
        'resume_args_template'
      )
    }
    if (value.yolo_args_template !== undefined) {
      result.yolo_args_template = jsonBodyValidator.nullableStringArray(
        value.yolo_args_template,
        'yolo_args_template'
      )
    }
    return result as Partial<CommandPresetBody>
  })
  return {
    ...(body.display_name !== undefined ? { displayName: body.display_name } : {}),
    ...(body.command !== undefined ? { command: body.command } : {}),
    ...(body.args !== undefined ? { args: body.args } : {}),
    ...(body.env !== undefined ? { env: body.env } : {}),
    ...(body.resume_args_template !== undefined
      ? { resumeArgsTemplate: body.resume_args_template }
      : {}),
    ...(body.session_id_capture !== undefined ? { sessionIdCapture: body.session_id_capture } : {}),
    ...(body.yolo_args_template !== undefined ? { yoloArgsTemplate: body.yolo_args_template } : {}),
  }
}

const readCommandPresetInput = async (
  request: Parameters<RouteDefinition['handler']>[0]['request']
) => {
  const body = await readCommandPresetBody(request)
  return {
    displayName: body.displayName ?? '',
    command: body.command ?? '',
    args: body.args ?? [],
    env: body.env ?? {},
    resumeArgsTemplate: body.resumeArgsTemplate ?? null,
    sessionIdCapture: body.sessionIdCapture ?? null,
    yoloArgsTemplate: body.yoloArgsTemplate ?? null,
  }
}

const readRoleTemplateBody = async (
  request: Parameters<RouteDefinition['handler']>[0]['request']
): Promise<Partial<RoleTemplateInput>> => {
  const body = await parseJsonBody<Partial<RoleTemplateBody>>(request, (raw) => {
    const value = jsonBodyValidator.object(raw)
    return {
      ...(value.name !== undefined ? { name: jsonBodyValidator.string(value.name, 'name') } : {}),
      ...(value.role_type !== undefined
        ? {
            role_type: jsonBodyValidator.string(
              value.role_type,
              'role_type'
            ) as RoleTemplateBody['role_type'],
          }
        : {}),
      ...(value.description !== undefined
        ? { description: jsonBodyValidator.string(value.description, 'description') }
        : {}),
      ...(value.default_command !== undefined
        ? { default_command: jsonBodyValidator.string(value.default_command, 'default_command') }
        : {}),
      ...(value.default_args !== undefined
        ? {
            default_args: jsonBodyValidator.optionalStringArray(value.default_args, 'default_args'),
          }
        : {}),
      ...(value.default_env !== undefined
        ? { default_env: jsonBodyValidator.optionalRecord(value.default_env, 'default_env') }
        : {}),
    } as Partial<RoleTemplateBody>
  })
  return {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.role_type !== undefined ? { roleType: body.role_type } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.default_command !== undefined ? { defaultCommand: body.default_command } : {}),
    ...(body.default_args !== undefined ? { defaultArgs: body.default_args } : {}),
    ...(body.default_env !== undefined ? { defaultEnv: body.default_env } : {}),
  }
}

const readRoleTemplateInput = async (
  request: Parameters<RouteDefinition['handler']>[0]['request']
) => {
  const body = await readRoleTemplateBody(request)
  return {
    name: body.name ?? '',
    roleType: body.roleType ?? 'custom',
    description: body.description ?? '',
    defaultCommand: body.defaultCommand ?? '',
    defaultArgs: body.defaultArgs ?? [],
    defaultEnv: body.defaultEnv ?? {},
  }
}

const readTeamTemplateBody = async (
  request: Parameters<RouteDefinition['handler']>[0]['request']
) => {
  const body = await parseJsonBody<Partial<TeamTemplateBody>>(request, (raw) => {
    const value = jsonBodyValidator.object(raw)
    if (value.workers !== undefined && !Array.isArray(value.workers)) {
      throw new BadRequestError('workers must be an array')
    }
    return {
      ...(value.name !== undefined ? { name: jsonBodyValidator.string(value.name, 'name') } : {}),
      ...(value.workers !== undefined
        ? {
            workers: value.workers.map((worker) => {
              const workerValue = jsonBodyValidator.object(worker)
              return {
                name: jsonBodyValidator.string(workerValue.name, 'workers.name'),
                role: jsonBodyValidator.string(
                  workerValue.role,
                  'workers.role'
                ) as TeamTemplateWorkerBody['role'],
                ...(workerValue.description !== undefined
                  ? {
                      description: jsonBodyValidator.string(
                        workerValue.description,
                        'workers.description'
                      ),
                    }
                  : {}),
                ...(workerValue.command_preset_id !== undefined
                  ? {
                      command_preset_id: jsonBodyValidator.nullableString(
                        workerValue.command_preset_id,
                        'workers.command_preset_id'
                      ),
                    }
                  : {}),
              }
            }),
          }
        : {}),
    } as Partial<TeamTemplateBody>
  })
  return {
    name: body.name ?? '',
    workers: (body.workers ?? []).map((worker) => ({
      name: worker.name ?? '',
      role: worker.role ?? 'custom',
      description: worker.description ?? '',
      commandPresetId: worker.command_preset_id ?? null,
    })),
  }
}

export const settingsRoutes: RouteDefinition[] = [
  route('GET', '/api/settings/command-presets', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, store.settings.listCommandPresets().map(serializeCommandPreset))
  }),
  route('POST', '/api/settings/command-presets', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(
      response,
      201,
      serializeCommandPreset(
        store.settings.createCommandPreset(await readCommandPresetInput(request))
      )
    )
  }),
  route(
    'PATCH',
    '/api/settings/command-presets/:presetId',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const presetId = getRequiredParam(response, params, 'presetId', 'Preset id is required')
      if (!presetId) return
      const current = store.settings.listCommandPresets().find((preset) => preset.id === presetId)
      if (!current) throw new Error(`Command preset not found: ${presetId}`)
      const next = { ...current, ...(await readCommandPresetBody(request)) }
      sendJson(
        response,
        200,
        serializeCommandPreset(store.settings.updateCommandPreset(presetId, next))
      )
    }
  ),
  route(
    'DELETE',
    '/api/settings/command-presets/:presetId',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const presetId = getRequiredParam(response, params, 'presetId', 'Preset id is required')
      if (!presetId) return
      store.settings.deleteCommandPreset(presetId)
      response.statusCode = 204
      response.end()
    }
  ),
  route('GET', '/api/settings/role-templates', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, store.settings.listRoleTemplates().map(serializeRoleTemplate))
  }),
  route('POST', '/api/settings/role-templates', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(
      response,
      201,
      serializeRoleTemplate(store.settings.createRoleTemplate(await readRoleTemplateInput(request)))
    )
  }),
  route(
    'PATCH',
    '/api/settings/role-templates/:templateId',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const templateId = getRequiredParam(response, params, 'templateId', 'Template id is required')
      if (!templateId) return
      const current = store.settings
        .listRoleTemplates()
        .find((template) => template.id === templateId)
      if (!current) throw new Error(`Role template not found: ${templateId}`)
      const next = { ...current, ...(await readRoleTemplateBody(request)) }
      sendJson(
        response,
        200,
        serializeRoleTemplate(store.settings.updateRoleTemplate(templateId, next))
      )
    }
  ),
  route(
    'DELETE',
    '/api/settings/role-templates/:templateId',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const templateId = getRequiredParam(response, params, 'templateId', 'Template id is required')
      if (!templateId) return
      store.settings.deleteRoleTemplate(templateId)
      response.statusCode = 204
      response.end()
    }
  ),
  route('GET', '/api/settings/team-templates', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, store.settings.listTeamTemplates().map(serializeTeamTemplate))
  }),
  route('POST', '/api/settings/team-templates', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(
      response,
      201,
      serializeTeamTemplate(store.settings.createTeamTemplate(await readTeamTemplateBody(request)))
    )
  }),
  route(
    'DELETE',
    '/api/settings/team-templates/:templateId',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const templateId = getRequiredParam(response, params, 'templateId', 'Template id is required')
      if (!templateId) return
      store.settings.deleteTeamTemplate(templateId)
      response.statusCode = 204
      response.end()
    }
  ),
  // R6 agent package: export a stored roster as a portable manifest.
  route(
    'GET',
    '/api/settings/team-templates/:templateId/package',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const templateId = getRequiredParam(response, params, 'templateId', 'Template id is required')
      if (!templateId) return
      const template = store.settings
        .listTeamTemplates()
        .find((candidate) => candidate.id === templateId)
      if (!template) {
        sendJson(response, 404, { error: 'Template not found' })
        return
      }
      sendJson(response, 200, {
        package: serializeTeamTemplateToPackage(template),
      })
    }
  ),
  // R6 agent package: import (validate + create as a team template).
  route(
    'POST',
    '/api/settings/team-templates/import-package',
    async ({ request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const body = await parseJsonBody<{ package?: unknown }>(request, (raw) => ({
        package: jsonBodyValidator.object(raw).package,
      }))
      try {
        const parsed = parseAgentPackage(body.package)
        const created = store.settings.createTeamTemplate({
          name: parsed.name,
          workers: parsed.workers,
        })
        sendJson(response, 201, {
          missing_skills: parsed.missingSkills,
          skills: parsed.skills,
          template: serializeTeamTemplate(created),
        })
      } catch (error) {
        if (error instanceof AgentPackageError) {
          sendJson(response, 400, {
            error: error.message,
            missing_skills: error.missingSkills,
            problems: error.problems,
          })
          return
        }
        throw error
      }
    }
  ),
  route('GET', '/api/settings/app-state/:key', ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const key = getRequiredParam(response, params, 'key', 'App state key is required')
    if (!key) return
    sendJson(response, 200, store.settings.getAppState(key) ?? { key, value: null })
  }),
  route('PUT', '/api/settings/app-state/:key', async ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const key = getRequiredParam(response, params, 'key', 'App state key is required')
    if (!key) return
    const body = await parseJsonBody<{ value: string | null }>(request, (raw) => {
      const value = jsonBodyValidator.object(raw)
      return { value: jsonBodyValidator.nullableString(value.value, 'value') ?? null }
    })
    store.settings.setAppState(key, body.value)
    response.statusCode = 204
    response.end()
  }),
]
