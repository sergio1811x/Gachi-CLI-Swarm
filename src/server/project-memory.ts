import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const memoryFiles = ['architecture.md', 'decisions.md', 'bugs.md', 'rules.md'] as const

export const ensureProjectMemory = (workspacePath: string) => {
  const directory = join(workspacePath, '.gachi', 'memory')
  mkdirSync(directory, { recursive: true })
  for (const filename of memoryFiles) {
    const path = join(directory, filename)
    if (!existsSync(path)) writeFileSync(path, `# ${filename.replace('.md', '')}\n\n`, 'utf8')
  }
  return directory
}

export const readProjectMemory = (workspacePath: string, maxLength = 6000) => {
  const directory = ensureProjectMemory(workspacePath)
  const content = memoryFiles
    .map((filename) => `## ${filename}\n${readFileSync(join(directory, filename), 'utf8').trim()}`)
    .join('\n\n')
  return content.slice(0, maxLength)
}
