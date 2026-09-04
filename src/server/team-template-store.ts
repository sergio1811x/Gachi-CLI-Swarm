import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

export interface TeamTemplateWorker {
  name: string
  role: 'coder' | 'reviewer' | 'tester' | 'custom'
  description: string
  commandPresetId: string | null
}

export interface TeamTemplateRecord {
  id: string
  name: string
  workers: TeamTemplateWorker[]
}

export interface TeamTemplateInput {
  name: string
  workers: TeamTemplateWorker[]
}

const parseWorkers = (value: string): TeamTemplateWorker[] => {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (item): item is TeamTemplateWorker =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { name?: unknown }).name === 'string'
  )
}

const toRecord = (row: { id: string; name: string; workers_json: string }): TeamTemplateRecord => ({
  id: row.id,
  name: row.name,
  workers: parseWorkers(row.workers_json),
})

export const createTeamTemplateStore = (db: Database) => {
  const list = (): TeamTemplateRecord[] =>
    db
      .prepare('SELECT id, name, workers_json FROM team_templates ORDER BY created_at ASC')
      .all()
      .map((row) => toRecord(row as Parameters<typeof toRecord>[0]))

  const create = (input: TeamTemplateInput): TeamTemplateRecord => {
    const record = { id: randomUUID(), name: input.name, workers: input.workers }
    const now = Date.now()
    db.prepare(
      `INSERT INTO team_templates (id, name, workers_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(record.id, record.name, JSON.stringify(record.workers), now, now)
    return record
  }

  const remove = (id: string): void => {
    db.prepare('DELETE FROM team_templates WHERE id = ?').run(id)
  }

  return { create, list, remove }
}
