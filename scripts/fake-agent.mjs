#!/usr/bin/env node
import { createInterface } from 'node:readline'

const mode = process.argv[2] ?? 'normal'

const dispatchIdFrom = (input) => {
  const match = /dispatch_id:\s*(\S+)/u.exec(input)
  return match ? match[1] : null
}

const prompt = '\u001b[?25l❯ '

const print = (line) => process.stdout.write(`${line}\n${prompt}`)

const structuredCompletion = (_dispatchId, status = 'completed') =>
  [
    `TASK_${status.toUpperCase()} {`,
    '  "taskId": "<injected-by-worker>",',
    '  "summary": "Implemented and verified on disk.",',
    '  "filesChanged": ["src/fake.ts", "tests/fake.test.ts"],',
    '  "tests": ["pnpm test"],',
    `  "status": "${status}"`,
    '}',
  ].join('\n')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const run = async () => {
  print('[FAKE-AGENT] startup: ready')

  const readline = createInterface({ input: process.stdin })
  let dispatchId = null
  const inputLines = []

  readline.on('line', async (line) => {
    inputLines.push(line)
    const found = dispatchIdFrom(line)
    if (found) dispatchId = found
  })

  // The orchestrator pastes the dispatch payload in one bracketed blob; wait
  // until a dispatch_id shows up before starting "work".
  while (dispatchId === null && mode !== 'timeout') {
    if (inputLines.some((line) => dispatchIdFrom(line))) {
      dispatchId = inputLines.map((l) => dispatchIdFrom(l)).find(Boolean)
      break
    }
    await sleep(50)
  }

  if (mode === 'timeout') {
    // Ready but never accepts nor completes.
    return
  }

  if (dispatchId === null) {
    print('[FAKE-AGENT] no task received; staying idle')
    return
  }

  print(`[FAKE-AGENT] accept dispatch ${dispatchId}`)

  if (mode === 'crash') {
    await sleep(100)
    process.stderr.write('[FAKE-AGENT] simulated crash\n')
    process.exit(3)
  }

  // Simulate working (print a progress marker so output is not "empty").
  print('[PROGRESS] 50%')
  await sleep(150)

  print(`[FAKE-AGENT] complete dispatch ${dispatchId}`)
  print(structuredCompletion(dispatchId, mode === 'nohbeat' ? 'completed' : 'completed'))
  print(`team report --file /dev/null --dispatch ${dispatchId}`)
  process.exit(0)
}

run().catch((error) => {
  process.stderr.write(String(error))
  process.exit(1)
})
