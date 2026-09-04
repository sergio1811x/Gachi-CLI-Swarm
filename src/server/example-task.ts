import { taskStore } from './task-store.js'

/**
 * R8 onboarding: an opt-in starter card seeded into a freshly created
 * workspace so the very first run has something concrete and safe to do.
 * The task is engine-agnostic, read-only for the repo (one report file under
 * `.gachi/`), and exercises the full loop: work → report.
 */
export const seedExampleTask = (workspaceId: string): string => {
  const task = taskStore.createTask(workspaceId, {
    title: 'Orientation: explore this project and write a summary',
    description: [
      'You are the first agent in this workspace. Get oriented:',
      '',
      '1. Read the README (or equivalent) at the repository root.',
      '2. List the top-level structure and identify the main language/framework.',
      '3. Write a short summary (purpose, stack, how to build/run) to',
      '   `.gachi/orientation.md` inside the workspace.',
      '4. Report back via `team report` with a 3-line digest.',
      '',
      'Do not modify any source files — this is a read-only orientation pass.',
    ].join('\n'),
  })
  return task.id
}
