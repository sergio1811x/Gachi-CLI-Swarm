import { describe, expect, test } from 'vitest'

import { generateWorkerName } from '../../web/src/worker/randomWorkerName.js'

describe('worker name generator', () => {
  test('returns the first English coder figure', () => {
    // EN_CODER[0] = ada-lovelace.
    expect(generateWorkerName({ language: 'en', role: 'coder', nextUint32: () => 0 })).toBe(
      'ada-lovelace'
    )
  })

  test('indexes into the reviewer pool', () => {
    // EN_REVIEWER[3] = aquinas.
    expect(generateWorkerName({ language: 'en', role: 'reviewer', nextUint32: () => 3 })).toBe(
      'aquinas'
    )
  })

  test('picks a tester-flavored figure for the tester role', () => {
    // EN_TESTER[12] = dalton.
    expect(generateWorkerName({ language: 'en', role: 'tester', nextUint32: () => 12 })).toBe(
      'dalton'
    )
  })

  test('keeps names safe for team send invocations', () => {
    const name = generateWorkerName({ language: 'en', role: 'coder', nextUint32: () => 8 })
    expect(name).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
    expect(name).not.toContain(' ')
  })

  test('switches to Chinese historical figures for Chinese UI', () => {
    // ZH_REVIEWER[0] = 班固.
    const name = generateWorkerName({ language: 'zh', role: 'reviewer', nextUint32: () => 0 })
    expect(name).toBe('班固')
    expect(name).not.toContain(' ')
  })

  test('matches the Chinese tester pool to the tester role', () => {
    // ZH_TESTER[16] = 李时珍 — picking an index that anchors the doctor /
    // naturalist flavor of the pool.
    expect(generateWorkerName({ language: 'zh', role: 'tester', nextUint32: () => 16 })).toBe(
      '李时珍'
    )
  })

  test('custom role draws from the union of all role pools', () => {
    // EN_CODER has 51 entries (indices 0..50), so EN_CUSTOM[51] is the first
    // reviewer = adam-smith.
    expect(generateWorkerName({ language: 'en', role: 'custom', nextUint32: () => 51 })).toBe(
      'adam-smith'
    )
  })

  test('skips names already used in the workspace', () => {
    // EN_CODER[0] = ada-lovelace, [1] = archimedes. If index 0 is taken,
    // drawing with `() => 0` against the filtered pool returns archimedes.
    const name = generateWorkerName({
      language: 'en',
      role: 'coder',
      usedNames: new Set(['ada-lovelace']),
      nextUint32: () => 0,
    })
    expect(name).toBe('archimedes')
  })

  test('different workspaces stay independent because callers pass their own usedNames', () => {
    // Caller for workspace A passes only A's used names; ada-lovelace is free
    // here even if workspace B already has one.
    const name = generateWorkerName({
      language: 'en',
      role: 'coder',
      usedNames: new Set(['tesla', 'turing']),
      nextUint32: () => 0,
    })
    expect(name).toBe('ada-lovelace')
  })

  test('falls back to the full pool when every figure is taken', () => {
    // Cover the entire Chinese tester pool so the filter returns nothing;
    // the function must still produce a name rather than throw or return an
    // empty string.
    const ZH_TESTER = [
      '班超',
      '扁鹊',
      '巢元方',
      '陈藏器',
      '法显',
      '甘德',
      '葛洪',
      '葛玄',
      '顾祖禹',
      '华佗',
      '皇甫谧',
      '嵇含',
      '贾耽',
      '鉴真',
      '郦道元',
      '李杲',
      '李时珍',
      '刘完素',
      '罗洪先',
      '落下闳',
      '钱乙',
      '神农',
      '石申',
      '司马承祯',
      '苏敬',
      '苏武',
      '孙思邈',
      '唐慎微',
      '陶弘景',
      '汪大渊',
      '王清任',
      '王叔和',
      '王焘',
      '王惟一',
      '吴鞠通',
      '吴又可',
      '谢肇淛',
      '徐光启',
      '徐霞客',
      '玄奘',
      '喻嘉言',
      '张从正',
      '张景岳',
      '张骞',
      '张仲景',
      '郑和',
      '周达观',
      '朱丹溪',
      '朱橚',
    ]
    const name = generateWorkerName({
      language: 'zh',
      role: 'tester',
      usedNames: new Set(ZH_TESTER),
      nextUint32: () => 0,
    })
    expect(ZH_TESTER).toContain(name)
  })
})
