import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

const setup = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-apkg-'))
  tempDirs.push(dataDir)
  const server = await startTestServer({ dataDir })
  servers.push(server)
  const cookie = await getUiCookie(server.baseUrl)
  return { baseUrl: server.baseUrl, cookie }
}

describe('agent package export/import API (R6)', () => {
  test('create template → export package → import as new template', async () => {
    const { baseUrl, cookie } = await setup()

    const createResponse = await fetch(`${baseUrl}/api/settings/team-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'Original crew',
        workers: [{ command_preset_id: null, description: '', name: 'A', role: 'coder' }],
      }),
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as { id: string }

    const exportResponse = await fetch(
      `${baseUrl}/api/settings/team-templates/${created.id}/package`,
      { headers: { cookie } }
    )
    expect(exportResponse.status).toBe(200)
    const { package: pkg } = (await exportResponse.json()) as {
      package: Record<string, unknown>
    }
    expect(pkg.format).toBe('gachi-agent-package')

    const importBody = {
      ...pkg,
      name: 'Imported crew',
      workers: [{ ...(pkg.workers as Array<Record<string, unknown>>)[0], role: 'reviewer' }],
    }
    const importResponse = await fetch(`${baseUrl}/api/settings/team-templates/import-package`, {
      body: JSON.stringify({ package: importBody }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(importResponse.status).toBe(201)
    const imported = (await importResponse.json()) as {
      template: { id: string; name: string; workers: Array<{ role: string }> }
    }
    expect(imported.template.name).toBe('Imported crew')
    expect(imported.template.workers[0]?.role).toBe('reviewer')
    expect(imported.template.id).not.toBe(created.id)
  })

  test('invalid package → 400 with problems; unknown skill reported', async () => {
    const { baseUrl, cookie } = await setup()

    const bad = await fetch(`${baseUrl}/api/settings/team-templates/import-package`, {
      body: JSON.stringify({
        package: { format: 'nope', version: 7, workers: [] },
      }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(bad.status).toBe(400)
    const badBody = (await bad.json()) as { problems: string[] }
    expect(badBody.problems.length).toBeGreaterThan(0)

    const unknownSkill = await fetch(`${baseUrl}/api/settings/team-templates/import-package`, {
      body: JSON.stringify({
        package: {
          format: 'gachi-agent-package',
          name: 'P',
          skills: ['mystery-skill'],
          version: 1,
          workers: [{ name: 'W', role: 'tester' }],
        },
      }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(unknownSkill.status).toBe(201)
    const skillBody = (await unknownSkill.json()) as { missing_skills: string[] }
    expect(skillBody.missing_skills).toEqual(['mystery-skill'])
  })

  test('export of unknown template → 404', async () => {
    const { baseUrl, cookie } = await setup()
    const response = await fetch(`${baseUrl}/api/settings/team-templates/nope/package`, {
      headers: { cookie },
    })
    expect(response.status).toBe(404)
  })
})
