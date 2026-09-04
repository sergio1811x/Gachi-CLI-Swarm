import { describe, expect, test } from 'vitest'

import {
  createSecretBox,
  DPAPI_PREFIX,
  KEYCHAIN_PREFIX,
  PLAIN_PREFIX,
  SecretBoxError,
} from '../../src/server/secret-box.js'

describe('secret box (audit M-2)', () => {
  test('plain envelope round-trips without any OS dependency', async () => {
    const box = createSecretBox()
    const sealed = await box.seal('legacy-token')
    // On non-Windows the seal is the explicit plaintext envelope; on Windows it
    // may be DPAPI — both must open back to the original value.
    expect(sealed === `${PLAIN_PREFIX}bGVnYWN5LXRva2Vu` || sealed.startsWith(DPAPI_PREFIX)).toBe(
      true
    )
    await expect(box.open(sealed)).resolves.toBe('legacy-token')
    expect(box.isSealed(sealed)).toBe(true)
  })

  test('legacy unmarked values pass through unchanged', async () => {
    const box = createSecretBox()
    await expect(box.open('123456:ABC-DEF_old_plaintext_token')).resolves.toBe(
      '123456:ABC-DEF_old_plaintext_token'
    )
    expect(box.isSealed('123456:ABC-DEF_old_plaintext_token')).toBe(false)
  })

  test('a corrupted dpapi envelope raises a typed error instead of leaking data', async () => {
    if (process.platform !== 'win32') return
    const box = createSecretBox()
    await expect(box.open(`${DPAPI_PREFIX}bm90LWEtcmVhbC1ibG9i`)).rejects.toBeInstanceOf(
      SecretBoxError
    )
  })

  test('dpapi seal/open round-trip keeps the token usable (Windows only)', async () => {
    if (process.platform !== 'win32') return
    const box = createSecretBox()
    const sealed = await box.seal('987654:ROUND_TRIP_token')
    expect(sealed.startsWith(DPAPI_PREFIX)).toBe(true)
    // The stored form must not contain the plaintext.
    expect(sealed.includes('ROUND_TRIP_token')).toBe(false)
    await expect(box.open(sealed)).resolves.toBe('987654:ROUND_TRIP_token')
  })
})

describe('keychain envelopes (audit M-2, non-Windows)', () => {
  /** Fake `security`/`secret-tool` backends with SEPARATE stores, like real OS keychains. */
  const fakeKeyring = () => {
    const macStore = new Map<string, string>()
    const linuxStore = new Map<string, string>()
    return {
      macStore,
      linuxStore,
      runner: async (file: string, args: string[], input?: string) => {
        if (file === 'security' && args[0] === 'add-generic-password') {
          const accountIdx = args.indexOf('-a')
          const secretIdx = args.indexOf('-w')
          macStore.set(args[accountIdx + 1]!, input ?? args[secretIdx + 1] ?? '')
          return ''
        }
        if (file === 'secret-tool' && args[0] === 'store') {
          const accountIdx = args.indexOf('account')
          linuxStore.set(args[accountIdx + 1]!, input ?? '')
          return ''
        }
        if (file === 'security' && args[0] === 'find-generic-password') {
          const secret = macStore.get(args[args.indexOf('-a') + 1] ?? '')
          if (secret === undefined) throw new Error('not found')
          return secret
        }
        if (file === 'secret-tool' && args[0] === 'lookup') {
          const secret = linuxStore.get(args[args.indexOf('account') + 1] ?? '')
          if (secret === undefined) throw new Error('not found')
          return secret
        }
        throw new Error(`unexpected command: ${file} ${args.join(' ')}`)
      },
    }
  }

  for (const platform of ['darwin', 'linux'] as const) {
    test(`${platform}: seal stores a reference, open resolves the secret`, async () => {
      const keyring = fakeKeyring()
      const box = createSecretBox({ platform, runner: keyring.runner })
      const sealed = await box.seal('AA11:keychain_round_trip')
      // Stored value is a reference — the plaintext never touches the DB.
      expect(sealed.startsWith(KEYCHAIN_PREFIX)).toBe(true)
      expect(sealed.includes('keychain_round_trip')).toBe(false)
      const backend = platform === 'darwin' ? keyring.macStore : keyring.linuxStore
      expect(backend.size).toBe(1)
      await expect(box.open(sealed)).resolves.toBe('AA11:keychain_round_trip')
      expect(box.isSealed(sealed)).toBe(true)
    })

    test(`${platform}: missing keyring entry raises a typed error`, async () => {
      const box = createSecretBox({
        platform,
        runner: fakeKeyring().runner,
      })
      await expect(
        box.open(`${KEYCHAIN_PREFIX}aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`)
      ).rejects.toBeInstanceOf(SecretBoxError)
    })

    test(`${platform}: broken CLI falls back to the explicit plain envelope`, async () => {
      const box = createSecretBox({
        platform,
        runner: async () => {
          throw new Error('command not found')
        },
      })
      const sealed = await box.seal('fallback-secret')
      expect(sealed.startsWith(PLAIN_PREFIX)).toBe(true)
      await expect(box.open(sealed)).resolves.toBe('fallback-secret')
    })
  }

  test('malformed keychain reference is rejected without spawning a CLI', async () => {
    let spawned = false
    const box = createSecretBox({
      platform: 'darwin',
      runner: async () => {
        spawned = true
        return ''
      },
    })
    await expect(box.open(`${KEYCHAIN_PREFIX}../etc/passwd`)).rejects.toBeInstanceOf(SecretBoxError)
    expect(spawned).toBe(false)
  })

  test('a mac keychain reference cannot be opened on linux and vice versa', async () => {
    const keyring = fakeKeyring()
    const macBox = createSecretBox({ platform: 'darwin', runner: keyring.runner })
    const linuxBox = createSecretBox({ platform: 'linux', runner: keyring.runner })
    const sealed = await macBox.seal('cross-platform-secret')
    await expect(linuxBox.open(sealed)).rejects.toBeInstanceOf(SecretBoxError)
  })

  test('unsupported platforms use the explicit plain envelope', async () => {
    const box = createSecretBox({
      platform: 'other',
      runner: async () => {
        throw new Error('should not spawn')
      },
    })
    const sealed = await box.seal('bsd-secret')
    expect(sealed.startsWith(PLAIN_PREFIX)).toBe(true)
    await expect(box.open(sealed)).resolves.toBe('bsd-secret')
  })
})
