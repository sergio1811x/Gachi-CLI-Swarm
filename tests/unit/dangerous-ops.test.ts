import { describe, expect, test } from 'vitest'

import { detectDangerousOps } from '../../src/server/dangerous-ops.js'

describe('detectDangerousOps (R10)', () => {
  test('force-push is flagged in any git push form', () => {
    expect(detectDangerousOps('git push --force origin main')).toContain('force-push')
    expect(detectDangerousOps('$ git push -f origin feature')).toContain('force-push')
    expect(detectDangerousOps('git push --force-with-lease=main:abc123 origin')).toContain(
      'force-push'
    )
  })

  test('root and wildcard deletes are flagged, ordinary cleanups are not', () => {
    expect(detectDangerousOps('rm -rf /')).toContain('rm-root')
    expect(detectDangerousOps('sudo rm -rf "/tmp"')).toEqual([]) // quoted /tmp is a path, not root
    expect(detectDangerousOps('rm -rf ~ && echo gone')).toContain('rm-wildcard')
    expect(detectDangerousOps('rm -rf *')).toContain('rm-wildcard')
    expect(detectDangerousOps('rm -rf node_modules build')).toEqual([])
    expect(detectDangerousOps('rm -rf /tmp/cache/segments')).toEqual([])
  })

  test('publish commands are flagged', () => {
    expect(detectDangerousOps('npm publish --access public')).toContain('publish')
    expect(detectDangerousOps('pnpm publish')).toContain('publish')
    expect(detectDangerousOps('npm run publish:docs')).toEqual([])
  })

  test('clean output yields no labels', () => {
    expect(detectDangerousOps('git commit -m "feat" && pnpm test')).toEqual([])
  })

  test('labels deduplicate across multiple hits', () => {
    const out = 'rm -rf *\ngit push --force origin main\nnpm publish\nrm -rf ~'
    const labels = detectDangerousOps(out)
    expect(labels).toEqual(['force-push', 'rm-wildcard', 'publish'])
  })
})
