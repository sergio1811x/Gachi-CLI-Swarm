import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createTasksFileService } from '../../src/server/tasks-file.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('tasks file service', () => {
  test('creates .gachi/tasks.md on first read and persists writes there', () => {
    const workspacePath = join(tmpdir(), `gachi-tasks-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const tasksPath = join(workspacePath, '.gachi', 'tasks.md')

    const service = createTasksFileService()

    expect(service.readTasks(workspacePath).content).toBe('')
    expect(existsSync(tasksPath)).toBe(true)
    expect(existsSync(join(workspacePath, 'tasks.md'))).toBe(false)

    service.writeTasks(workspacePath, '- [ ] implement login\n')

    expect(service.readTasks(workspacePath).content).toBe('- [ ] implement login\n')
    expect(readFileSync(tasksPath, 'utf8')).toBe('- [ ] implement login\n')
  })
})
