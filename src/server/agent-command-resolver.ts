import { accessSync, constants } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'

const hasPathSeparator = (command: string) => command.includes('/') || command.includes('\\')

const canExecute = (path: string, platform = process.platform): boolean => {
  try {
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

const createCommandNotFoundError = (command: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${command} CLI not found in PATH`), {
    code: 'ENOENT',
    path: command,
  })

interface ResolvedSpawnCommand {
  args: string[]
  command: string
}

const getEnvValue = (
  env: NodeJS.ProcessEnv,
  key: string,
  platform = process.platform
): string | undefined => {
  if (platform !== 'win32') return env[key]
  const matchedKey = Object.keys(env).find((item) => item.toLowerCase() === key.toLowerCase())
  return matchedKey ? env[matchedKey] : undefined
}

const getWindowsExecutableNames = (
  command: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string[] => {
  if (extname(command)) return [command]

  const extensions = (getEnvValue(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
  return [...extensions.map((extension) => `${command}${extension}`), command]
}

const getExecutableNames = (
  command: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string[] =>
  platform === 'win32' ? getWindowsExecutableNames(command, env, platform) : [command]

/** Retired CLI names that map to their replacement binary. */
const COMMAND_ALIASES: Record<string, string> = {
  gemini: 'agy',
}

export const resolveCommandPath = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string => {
  // Alias resolution: `gemini` → `agy` for pre-migration launch configs.
  const alias = COMMAND_ALIASES[command.toLowerCase()]
  if (alias) {
    try {
      return resolveCommandPath(alias, cwd, env, platform)
    } catch {
      // agy not found either — fall through to original command (will throw below).
    }
  }
  if (hasPathSeparator(command)) {
    for (const name of getExecutableNames(command, env, platform)) {
      const candidate = isAbsolute(name) ? name : join(cwd, name)
      if (canExecute(candidate, platform)) return candidate
    }
    throw createCommandNotFoundError(command)
  }

  for (const pathEntry of (getEnvValue(env, 'PATH', platform) ?? '').split(delimiter)) {
    if (!pathEntry) continue
    for (const name of getExecutableNames(command, env, platform)) {
      const candidate = join(pathEntry, name)
      if (canExecute(candidate, platform)) return candidate
    }
  }

  throw createCommandNotFoundError(command)
}

// ConPTY gives every spawned process tree a brand-new console whose output
// codepage defaults to the OS's OEM codepage (e.g. 866 on Russian Windows),
// not UTF-8 — so any non-ASCII output the launched CLI (or anything it
// shells out to later: python, pip, nested PowerShell calls, …) prints
// turns into mojibake in the PTY. The codepage is a per-console attribute
// inherited by the whole process tree, so switching to 65001 once before
// running the real command fixes it for the entire session — not just
// `.cmd`/`.bat` shims, but native `.exe` agent binaries too (e.g. Go-built
// CLIs), which is why this wraps every Windows launch through cmd.exe
// rather than only batch files.
//
// IMPORTANT: pass `chcp`, its args, `&`, and the real command as SEPARATE
// array elements — do not pre-quote them into one string. node-pty's own
// Windows arg-to-command-line converter (windowsPtyAgent.js#argsToCommandLine)
// re-quotes any array element that "looks unbalanced" (starts unquoted but
// ends in a quote, which a hand-built `chcp ... && "quoted path"` string
// does), and when it does it escapes embedded `"` as `\"` — a convention
// cmd.exe's own parser doesn't understand, so a pre-quoted command line gets
// silently mangled. Letting node-pty quote each plain token itself avoids
// this entirely, since none of the individual tokens has an embedded quote.
export const resolveSpawnCommand = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[] = [],
  platform = process.platform
): ResolvedSpawnCommand => {
  const resolvedCommand = resolveCommandPath(command, cwd, env, platform)
  if (platform === 'win32') {
    return {
      args: ['/d', '/c', 'chcp', '65001>nul', '&', resolvedCommand, ...args],
      command: getEnvValue(env, 'ComSpec', platform) ?? 'cmd.exe',
    }
  }
  return { args, command: resolvedCommand }
}

export const assertCommandIsExecutable = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): void => {
  resolveCommandPath(command, cwd, env)
}

export type { ResolvedSpawnCommand }
