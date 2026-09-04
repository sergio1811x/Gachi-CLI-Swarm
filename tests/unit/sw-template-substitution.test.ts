import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import { GACHI_SW_TOKEN, substituteSwTemplate } from '../../web/src/pwa/build-sw.js'

const REAL_TEMPLATE_URL = new URL('../../web/src/sw.template.js', import.meta.url)

describe('substituteSwTemplate', () => {
  // Guard: if the template no longer contains the token, every other test in
  // this file becomes trivially-true. We pin this invariant explicitly.
  test('the real SW template contains the version token at least once', () => {
    const template = readFileSync(fileURLToPath(REAL_TEMPLATE_URL), 'utf8')
    expect(template).toContain(GACHI_SW_TOKEN)
  })

  test('replaces every occurrence of the token with the provided version', () => {
    const template = "const A = '__GACHI_VERSION__'\nconst B = `prefix-__GACHI_VERSION__-suffix`"
    const output = substituteSwTemplate(template, '1.2.3-fixture')
    expect(output).toBe("const A = '1.2.3-fixture'\nconst B = `prefix-1.2.3-fixture-suffix`")
    expect(output).not.toContain(GACHI_SW_TOKEN)
  })

  test('passes through templates that do not contain the token unchanged', () => {
    const template = 'no token here'
    expect(substituteSwTemplate(template, 'x.y.z')).toBe(template)
  })

  test('substitutes the real template so the output is a usable SW source', () => {
    const template = readFileSync(fileURLToPath(REAL_TEMPLATE_URL), 'utf8')
    const output = substituteSwTemplate(template, '0.0.0-fixture')
    expect(output).toContain('0.0.0-fixture')
    expect(output).not.toContain(GACHI_SW_TOKEN)
    // Sanity that the rest of the SW source survived the substitution.
    expect(output).toContain('SHELL_CACHE')
    expect(output).toContain("addEventListener('fetch'")
  })
})
