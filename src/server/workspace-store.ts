import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'

import type { AgentSummary } from '../shared/types.js'
import { ConflictError } from './http-errors.js'
import { getDefaultRoleDescription } from './role-templates.js'
import type {
  WorkerInput,
  WorkerUpdateInput,
  WorkspaceRecord,
  WorkspaceStore,
} from './workspace-store-contract.js'
import { hydrateWorkspaceFromDb, seedWorkspacesFromDb } from './workspace-store-hydration.js'
import {
  getAgentRecord,
  getWorkerByNameRecord,
  getWorkerRecord,
  markAgentStarted,
  markAgentStopped,
  markTaskCancelled,
  markTaskDispatched,
  markTaskReported,
} from './workspace-store-mutations.js'
import {
  createOrchestrator,
  isWorkerAgent,
  type MessageKindRecord,
} from './workspace-store-support.js'

export type { WorkerInput, WorkerUpdateInput, WorkspaceRecord, WorkspaceStore }

const normalizeWorkerName = (name: string) => {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Worker name must not be empty')
  if (trimmed.length > 64) throw new Error('Worker name must be 64 characters or fewer')
  return trimmed
}

const normalizeDescription = (description: string) => {
  const trimmed = description.trim()
  if (trimmed.length > 2000) throw new Error('Worker description must be 2000 characters or fewer')
  return trimmed
}

const normalizeWorkspaceName = (name: string) => {
  if (typeof name !== 'string') throw new Error('Workspace name must be a string')
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Workspace name must not be empty')
  if (trimmed.length > 64) throw new Error('Workspace name must be 64 characters or fewer')
  return trimmed
}

export const createWorkspaceStore = (
  db: Database,
  messageKinds: MessageKindRecord[]
): WorkspaceStore => {
  const workspaces = new Map<string, WorkspaceRecord>()
  seedWorkspacesFromDb(db, workspaces, messageKinds)

  const getWorkspace = (workspaceId: string) => {
    hydrateWorkspaceFromDb(db, workspaces, messageKinds, workspaceId)
    const workspace = workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    return workspace
  }

  return {
    addWorker(workspaceId, input) {
      const workspace = getWorkspace(workspaceId)
      const name = normalizeWorkerName(input.name)
      const description =
        input.description === undefined
          ? getDefaultRoleDescription(input.role)
          : normalizeDescription(input.description)
      if (workspace.agents.some((agent) => agent.name === name && isWorkerAgent(agent))) {
        throw new ConflictError(`Worker name already exists: ${name}`)
      }
      const worker: AgentSummary = {
        id: randomUUID(),
        workspaceId,
        name,
        description,
        role: input.role,
        status: 'stopped',
        pendingTaskCount: 0,
      }
      const createdAt = Date.now()
      db.transaction(() => {
        db.prepare(
          'INSERT INTO workers (id, workspace_id, name, description, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(worker.id, workspaceId, worker.name, worker.description, worker.role, createdAt)
        db.prepare(
          'INSERT INTO agent_lifecycles (workspace_id, agent_id, state, run_id, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(workspaceId, worker.id, 'created', null, null, createdAt)
        db.prepare(
          'INSERT INTO agent_lifecycle_events (id, workspace_id, agent_id, from_state, to_state, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(randomUUID(), workspaceId, worker.id, null, 'created', 'worker_created', createdAt)
      })()
      workspace.agents.push(worker)
      return worker
    },
    createWorkspace(path, name) {
      const normalizedName = normalizeWorkspaceName(name)
      const existing = db.prepare('SELECT id FROM workspaces WHERE path = ? LIMIT 1').get(path) as
        | { id: string }
        | undefined
      if (existing) {
        throw new ConflictError('Workspace already exists for this path')
      }
      const summary = { id: randomUUID(), name: normalizedName, path }
      try {
        db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
          summary.id,
          normalizedName,
          path,
          Date.now()
        )
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed/u.test(error.message)) {
          throw new ConflictError('Workspace already exists for this path')
        }
        throw error
      }
      workspaces.set(summary.id, { summary, agents: [createOrchestrator(summary.id)] })
      return summary
    },
    renameWorkspace(workspaceId, name) {
      const workspace = getWorkspace(workspaceId)
      const trimmed = normalizeWorkerName(name)
      if (trimmed === workspace.summary.name) return workspace.summary
      db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(trimmed, workspaceId)
      workspace.summary = { ...workspace.summary, name: trimmed }
      return workspace.summary
    },
    deleteWorkspace(workspaceId) {
      const workspace = getWorkspace(workspaceId)
      const agentIds = workspace.agents.map((agent) => agent.id)
      db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE workspace_id = ?').run(workspaceId)
        db.prepare('DELETE FROM agent_launch_configs WHERE workspace_id = ?').run(workspaceId)
        db.prepare('DELETE FROM agent_sessions WHERE workspace_id = ?').run(workspaceId)
        db.prepare('DELETE FROM agent_lifecycle_events WHERE workspace_id = ?').run(workspaceId)
        db.prepare('DELETE FROM agent_lifecycles WHERE workspace_id = ?').run(workspaceId)
        const deleteAgentRuns = db.prepare('DELETE FROM agent_runs WHERE agent_id = ?')
        for (const agentId of agentIds) deleteAgentRuns.run(agentId)
        db.prepare('DELETE FROM workers WHERE workspace_id = ?').run(workspaceId)
        db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId)
      })()
      workspaces.delete(workspaceId)
    },
    renameWorker(workspaceId, workerId, name) {
      const worker = getWorkerRecord(workspaces, workspaceId, workerId)
      const trimmed = normalizeWorkerName(name)
      if (trimmed === worker.name) return worker
      const workspace = getWorkspace(workspaceId)
      if (
        workspace.agents.some(
          (agent) => agent.id !== workerId && agent.name === trimmed && isWorkerAgent(agent)
        )
      ) {
        throw new ConflictError(`Worker name already exists: ${trimmed}`)
      }
      db.prepare('UPDATE workers SET name = ? WHERE workspace_id = ? AND id = ?').run(
        trimmed,
        workspaceId,
        workerId
      )
      worker.name = trimmed
      return worker
    },
    updateWorker(workspaceId, workerId, input) {
      const worker = getWorkerRecord(workspaces, workspaceId, workerId)
      const nextName = input.name === undefined ? worker.name : normalizeWorkerName(input.name)
      const nextDescription =
        input.description === undefined
          ? worker.description
          : normalizeDescription(input.description)
      if (nextName !== worker.name) {
        const workspace = getWorkspace(workspaceId)
        if (
          workspace.agents.some(
            (agent) => agent.id !== workerId && agent.name === nextName && isWorkerAgent(agent)
          )
        ) {
          throw new ConflictError(`Worker name already exists: ${nextName}`)
        }
      }
      if (nextName === worker.name && nextDescription === worker.description) return worker
      db.prepare(
        'UPDATE workers SET name = ?, description = ? WHERE workspace_id = ? AND id = ?'
      ).run(nextName, nextDescription, workspaceId, workerId)
      worker.name = nextName
      worker.description = nextDescription
      return worker
    },
    deleteWorker(workspaceId, workerId) {
      const workspace = getWorkspace(workspaceId)
      getWorkerRecord(workspaces, workspaceId, workerId)
      db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE workspace_id = ? AND worker_id = ?').run(
          workspaceId,
          workerId
        )
        db.prepare('DELETE FROM agent_launch_configs WHERE workspace_id = ? AND agent_id = ?').run(
          workspaceId,
          workerId
        )
        db.prepare('DELETE FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?').run(
          workspaceId,
          workerId
        )
        db.prepare(
          'DELETE FROM agent_lifecycle_events WHERE workspace_id = ? AND agent_id = ?'
        ).run(workspaceId, workerId)
        db.prepare('DELETE FROM agent_lifecycles WHERE workspace_id = ? AND agent_id = ?').run(
          workspaceId,
          workerId
        )
        db.prepare('DELETE FROM agent_runs WHERE agent_id = ?').run(workerId)
        db.prepare('DELETE FROM workers WHERE workspace_id = ? AND id = ?').run(
          workspaceId,
          workerId
        )
      })()
      workspace.agents = workspace.agents.filter((agent) => agent.id !== workerId)
    },
    getAgent: (workspaceId, agentId) => getAgentRecord(workspaces, workspaceId, agentId),
    getWorker: (workspaceId, workerId) => getWorkerRecord(workspaces, workspaceId, workerId),
    getWorkerByName: (workspaceId, workerName) =>
      getWorkerByNameRecord(workspaces, workspaceId, workerName),
    getWorkspaceSnapshot: getWorkspace,
    hasAgent(workspaceId, agentId) {
      hydrateWorkspaceFromDb(db, workspaces, messageKinds, workspaceId)
      return workspaces.get(workspaceId)?.agents.some((agent) => agent.id === agentId) ?? false
    },
    listWorkers(workspaceId) {
      return getWorkspace(workspaceId)
        .agents.filter(isWorkerAgent)
        .map(({ description, id, name, role, status, pendingTaskCount }) => ({
          id,
          name,
          role,
          status,
          pendingTaskCount,
          description,
        }))
    },
    listWorkspaces() {
      return Array.from(workspaces.values(), (workspace) => workspace.summary)
    },
    markAgentStarted: (workspaceId, agentId) => markAgentStarted(workspaces, workspaceId, agentId),
    markAgentStopped: (workspaceId, agentId) => markAgentStopped(workspaces, workspaceId, agentId),
    markTaskDispatched: (workspaceId, workerId) =>
      markTaskDispatched(workspaces, workspaceId, workerId),
    markTaskCancelled: (workspaceId, workerId) =>
      markTaskCancelled(workspaces, workspaceId, workerId),
    markTaskReported: (workspaceId, workerId) =>
      markTaskReported(workspaces, workspaceId, workerId),
  }
}
