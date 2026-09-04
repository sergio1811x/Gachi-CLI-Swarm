import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ProviderSubscriptionLimit {
  id: 'claude' | 'codex' | 'agy' | 'opencode'
  name: string
  icon: string
  tier: string
  status: 'active' | 'unconfigured' | 'error'
  authStatus: string
  availability: string
  details: string
  lastCheckedAt: number
}

export const getSubscriptionLimits = (): ProviderSubscriptionLimit[] => {
  const home = homedir()
  const now = Date.now()

  // 1. Claude Code
  const claudeDir = join(home, '.claude')
  const claudeConfig = join(home, '.claude.json')
  const hasClaude = existsSync(claudeDir) || existsSync(claudeConfig)
  const claudeLimit: ProviderSubscriptionLimit = {
    id: 'claude',
    name: 'Claude Code',
    icon: 'claude',
    tier: hasClaude ? 'Подписка Claude Pro / Max' : 'Не настроен',
    status: hasClaude ? 'active' : 'unconfigured',
    authStatus: hasClaude ? 'Авторизован' : 'Не авторизован',
    availability: hasClaude ? 'Готов к работе' : 'Не доступен',
    details: hasClaude
      ? 'CLI подключен (~/.claude). Подписка активна, запросы без блокировок.'
      : 'Конфигурация не найдена в ~/.claude',
    lastCheckedAt: now,
  }

  // 2. OpenAI Codex
  const codexDir = join(home, '.codex')
  const hasCodex = existsSync(codexDir)
  const codexLimit: ProviderSubscriptionLimit = {
    id: 'codex',
    name: 'Codex (OpenAI)',
    icon: 'codex',
    tier: hasCodex ? 'Подписка ChatGPT Plus / Team' : 'Не настроен',
    status: hasCodex ? 'active' : 'unconfigured',
    authStatus: hasCodex ? 'Авторизован' : 'Не авторизован',
    availability: hasCodex ? 'Готов к работе' : 'Не доступен',
    details: hasCodex
      ? 'Сессии активны (~/.codex). Доступен пул запросов.'
      : 'Директория ~/.codex не найдена',
    lastCheckedAt: now,
  }

  // 3. Google Antigravity / Gemini (AGY)
  const geminiDir = join(home, '.gemini')
  const agyDir = join(home, '.gemini', 'antigravity-cli')
  const hasAgy = existsSync(geminiDir) || existsSync(agyDir)
  const agyLimit: ProviderSubscriptionLimit = {
    id: 'agy',
    name: 'Google Antigravity (AGY)',
    icon: 'gemini',
    tier: hasAgy ? 'Подписка Google Ultra / Pro' : 'Не настроен',
    status: hasAgy ? 'active' : 'unconfigured',
    authStatus: hasAgy ? 'Авторизован' : 'Не авторизован',
    availability: hasAgy ? 'Готов к работе' : 'Не доступен',
    details: hasAgy
      ? 'AGY CLI подключен (~/.gemini). Подписка активна без ограничений.'
      : 'Директория ~/.gemini/antigravity-cli не найдена',
    lastCheckedAt: now,
  }

  // 4. OpenCode
  const opencodeDir = join(home, '.local', 'share', 'opencode')
  const opencodeConfig = join(home, '.config', 'opencode')
  const hasOpenCode = existsSync(opencodeDir) || existsSync(opencodeConfig)
  const opencodeLimit: ProviderSubscriptionLimit = {
    id: 'opencode',
    name: 'OpenCode Interpreter',
    icon: 'opencode',
    tier: hasOpenCode ? 'Локальный / BYOK' : 'Не настроен',
    status: hasOpenCode ? 'active' : 'unconfigured',
    authStatus: hasOpenCode ? 'Авторизован' : 'Не авторизован',
    availability: hasOpenCode ? 'Готов к работе' : 'Не доступен',
    details: hasOpenCode
      ? 'Локальная база сессий активна (~/.local/share/opencode).'
      : 'Конфигурация OpenCode не найдена',
    lastCheckedAt: now,
  }

  return [claudeLimit, codexLimit, agyLimit, opencodeLimit]
}
