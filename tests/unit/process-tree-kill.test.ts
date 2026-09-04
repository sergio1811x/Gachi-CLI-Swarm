import { spawn } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'

import { isPidAlive, killTree, stopRunProcessTree } from '../../src/server/process-tree-kill.js'

const children: Array<{ kill: () => void }> = []

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
})

const spawnSleeper = () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  children.push(child)
  return child
}

describe('process tree kill (orphaned CLI fix)', () => {
  test('isPidAlive distinguishes live pids from garbage', () => {
    expect(isPidAlive(process.pid)).toBe(true)
    expect(isPidAlive(null)).toBe(false)
    expect(isPidAlive(0)).toBe(false)
    // Negative pids are never valid liveness targets here (and -1 would signal groups).
    expect(isPidAlive(-5)).toBe(false)
  })

  test('killTree terminates a spawned process', async () => {
    const child = spawnSleeper()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(child.pid).toBeGreaterThan(0)
    expect(isPidAlive(child.pid)).toBe(true)

    await killTree(child.pid!)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(isPidAlive(child.pid)).toBe(false)
  }, 15_000)

  test('stopRunProcessTree escalates when the plain stop leaves the process alive', async () => {
    const child = spawnSleeper()
    await new Promise((resolve) => setTimeout(resolve, 150))

    await stopRunProcessTree(
      child.pid,
      () => {
        /* no-op stop: simulates ConPTY killing only the host */
      },
      100
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(isPidAlive(child.pid)).toBe(false)
  }, 15_000)

  test('stopRunProcessTree is safe with unknown pids and throwing stops', async () => {
    await expect(
      stopRunProcessTree(
        null,
        () => {
          throw new Error('pty exploded')
        },
        10
      )
    ).resolves.toBeUndefined()
  })
})
