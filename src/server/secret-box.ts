import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/**
 * At-rest protection for long-lived secrets (Telegram bot token) — audit M-2.
 *
 * Platform matrix:
 *   Windows — DPAPI (CurrentUser scope); a leaked `runtime.sqlite` no longer
 *             contains a usable credential.
 *   macOS   — Login Keychain via the `security` CLI; the database stores only
 *             a `keychain:v1:<account>` reference, never the secret.
 *   Linux   — libsecret-compatible keyring via `secret-tool` (GNOME Keyring,
 *             KSecretsService); same reference envelope as macOS.
 *   Other / broken shells — explicit `plain:v1:<base64>` envelope so the app
 *             keeps working; the threat model is documented next to the
 *             Telegram settings.
 *
 * Format markers make every stored value self-describing:
 *   dpapi:v1:<base64>          — Windows DPAPI blob
 *   keychain:v1:<account>      — OS keychain reference (macOS/Linux)
 *   plain:v1:<base64>          — explicit unprotected envelope
 * Values without a marker are legacy plaintext and pass through unchanged, so
 * existing installations keep working and re-save migrates them.
 */

export const DPAPI_PREFIX = 'dpapi:v1:'
export const PLAIN_PREFIX = 'plain:v1:'
export const KEYCHAIN_PREFIX = 'keychain:v1:'

const DPAPI_TIMEOUT_MS = 5_000
const KEYCHAIN_SERVICE = 'gachi-cli-swarm'

const toBase64Utf8 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')
const fromBase64Utf8 = (value: string): string => Buffer.from(value, 'base64').toString('utf8')

/** Injectable command runner so tests can fake the OS tooling. */
export type SecretCliRunner = (file: string, args: string[], input?: string) => Promise<string>

const spawnRunner =
  (timeoutMs: number): SecretCliRunner =>
  (file, args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`${file} operation timed out`))
      }, timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(stdout.trim())
        else reject(new Error(stderr.trim() || `${file} exited with code ${code}`))
      })
      child.stdin.end(input ?? '', 'utf8')
    })

const DPAPI_PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))',
].join('; ')

const DPAPI_UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))',
].join('; ')

export interface SecretBox {
  /** True when the value carries one of our format markers. */
  isSealed: (stored: string) => boolean
  /** Wraps plaintext into the platform-appropriate storage envelope. */
  seal: (plaintext: string) => Promise<string>
  /**
   * Opens a sealed value. Legacy unmarked values are returned unchanged;
   * a marked envelope that cannot be opened throws `SecretBoxError`.
   */
  open: (stored: string) => Promise<string>
}

export class SecretBoxError extends Error {}

export interface SecretBoxOptions {
  /** Test hook: replace the process-spawning runner. */
  runner?: SecretCliRunner
  /** Test hook: force the platform branch instead of process.platform. */
  platform?: 'win32' | 'darwin' | 'linux' | 'other'
}

export const createSecretBox = (options: SecretBoxOptions = {}): SecretBox => {
  const platform =
    options.platform ??
    (process.platform === 'win32'
      ? 'win32'
      : process.platform === 'darwin'
        ? 'darwin'
        : process.platform === 'linux'
          ? 'linux'
          : 'other')
  const run = options.runner ?? spawnRunner(DPAPI_TIMEOUT_MS)

  // --- macOS Keychain (`security` CLI) -------------------------------------
  const macStore = async (plaintext: string): Promise<string> => {
    const account = randomUUID()
    await run('security', [
      'add-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      account,
      '-w',
      plaintext,
      '-U',
    ])
    return `${KEYCHAIN_PREFIX}${account}`
  }
  const macOpen = async (account: string): Promise<string> =>
    run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'])

  // --- Linux keyring (`secret-tool`, libsecret) ----------------------------
  const linuxStore = async (plaintext: string): Promise<string> => {
    const account = randomUUID()
    await run(
      'secret-tool',
      ['store', '--label=gachi-cli-swarm', 'service', KEYCHAIN_SERVICE, 'account', account],
      plaintext
    )
    return `${KEYCHAIN_PREFIX}${account}`
  }
  const linuxOpen = async (account: string): Promise<string> =>
    run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account])

  const keychainStore = platform === 'darwin' ? macStore : linuxStore
  const keychainOpen = platform === 'darwin' ? macOpen : linuxOpen

  return {
    isSealed(stored) {
      return (
        stored.startsWith(DPAPI_PREFIX) ||
        stored.startsWith(PLAIN_PREFIX) ||
        stored.startsWith(KEYCHAIN_PREFIX)
      )
    },

    async seal(plaintext) {
      if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
        return `${PLAIN_PREFIX}${toBase64Utf8(plaintext)}`
      }
      if (platform === 'win32') {
        try {
          const protectedB64 = await run(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', DPAPI_PROTECT_SCRIPT],
            toBase64Utf8(plaintext)
          )
          return `${DPAPI_PREFIX}${protectedB64}`
        } catch (error) {
          // A broken shell must not take settings saving down; fall back to the
          // explicit plaintext envelope and surface why.
          console.error(
            '[SECRETS] DPAPI seal failed, storing explicit plaintext envelope:',
            error instanceof Error ? error.message : error
          )
          return `${PLAIN_PREFIX}${toBase64Utf8(plaintext)}`
        }
      }
      try {
        return await keychainStore(plaintext)
      } catch (error) {
        console.error(
          `[SECRETS] ${platform === 'darwin' ? 'Keychain' : 'secret-tool'} seal failed, storing explicit plaintext envelope:`,
          error instanceof Error ? error.message : error
        )
        return `${PLAIN_PREFIX}${toBase64Utf8(plaintext)}`
      }
    },

    async open(stored) {
      if (stored.startsWith(PLAIN_PREFIX)) return fromBase64Utf8(stored.slice(PLAIN_PREFIX.length))
      if (stored.startsWith(KEYCHAIN_PREFIX)) {
        const account = stored.slice(KEYCHAIN_PREFIX.length)
        if (!/^[A-Za-z0-9-]{8,64}$/.test(account)) {
          throw new SecretBoxError('Malformed keychain reference')
        }
        if (platform !== 'darwin' && platform !== 'linux') {
          throw new SecretBoxError('Keychain-sealed secret cannot be opened on this platform')
        }
        try {
          return await keychainOpen(account)
        } catch (error) {
          throw new SecretBoxError(
            error instanceof Error ? error.message : 'Keychain lookup failed'
          )
        }
      }
      if (stored.startsWith(DPAPI_PREFIX)) {
        if (platform !== 'win32') {
          throw new SecretBoxError('DPAPI-sealed secret cannot be opened outside Windows')
        }
        try {
          const plainB64 = await run(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', DPAPI_UNPROTECT_SCRIPT],
            stored.slice(DPAPI_PREFIX.length)
          )
          return fromBase64Utf8(plainB64)
        } catch (error) {
          // Typed failure so callers can distinguish corruption from absence.
          throw new SecretBoxError(
            error instanceof Error ? error.message : 'DPAPI unprotect failed'
          )
        }
      }
      // Legacy plaintext from before sealing existed.
      return stored
    },
  }
}
