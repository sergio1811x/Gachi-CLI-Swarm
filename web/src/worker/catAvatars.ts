import { useEffect, useState } from 'react'

/**
 * Filenames in `web/public/cats_from_memes/` are `cat (N).webp` for
 * N = 1..913, except N = 304 which does not exist on disk.
 */
const CAT_AVATAR_RANGES: Array<[number, number]> = [
  [1, 303],
  [305, 913],
]

export const CAT_AVATAR_FILENAMES: string[] = CAT_AVATAR_RANGES.flatMap(([start, end]) =>
  Array.from({ length: end - start + 1 }, (_, index) => `cat (${start + index}).webp`)
)

export const catAvatarUrl = (filename: string): string =>
  `${import.meta.env.BASE_URL}cats_from_memes/${encodeURIComponent(filename)}`

const randomCatAvatarFilename = (excluding?: string): string => {
  if (CAT_AVATAR_FILENAMES.length <= 1) return CAT_AVATAR_FILENAMES[0] ?? ''
  let pick: string
  do {
    pick = CAT_AVATAR_FILENAMES[Math.floor(Math.random() * CAT_AVATAR_FILENAMES.length)] as string
  } while (pick === excluding)
  return pick
}

const storageKey = (agentId: string) => `gachi:worker-avatar:${agentId}`

/** Cross-component sync: multiple useWorkerAvatar(agentId) instances (card + edit
 * dialog) each hold their own useState, backed by the same localStorage key. Without
 * this, randomizing in one place only updates that instance until a remount/reload. */
const avatarListeners = new Map<string, Set<(filename: string) => void>>()
const notifyAvatarChange = (agentId: string, filename: string) => {
  for (const listener of avatarListeners.get(agentId) ?? []) listener(filename)
}

/** Returns this worker's assigned cat avatar filename, assigning one on first read. */
export const getWorkerAvatarFilename = (agentId: string): string => {
  if (typeof window === 'undefined') return CAT_AVATAR_FILENAMES[0] ?? ''
  const key = storageKey(agentId)
  const existing = window.localStorage.getItem(key)
  if (existing) return existing
  const assigned = randomCatAvatarFilename()
  window.localStorage.setItem(key, assigned)
  return assigned
}

/** Assigns a new random avatar (different from the current one) and returns it. */
export const randomizeWorkerAvatar = (agentId: string): string => {
  const key = storageKey(agentId)
  const current = typeof window === 'undefined' ? undefined : window.localStorage.getItem(key)
  const next = randomCatAvatarFilename(current ?? undefined)
  if (typeof window !== 'undefined') window.localStorage.setItem(key, next)
  notifyAvatarChange(agentId, next)
  return next
}

/** Reactive avatar assignment for a worker, persisted in localStorage and synced
 * live across every component instance watching the same agentId. */
export const useWorkerAvatar = (agentId: string): { filename: string; randomize: () => void } => {
  const [filename, setFilename] = useState(() => getWorkerAvatarFilename(agentId))
  useEffect(() => {
    setFilename(getWorkerAvatarFilename(agentId))
    const listeners = avatarListeners.get(agentId) ?? new Set()
    listeners.add(setFilename)
    avatarListeners.set(agentId, listeners)
    return () => {
      listeners.delete(setFilename)
      if (listeners.size === 0) avatarListeners.delete(agentId)
    }
  }, [agentId])
  const randomize = () => setFilename(randomizeWorkerAvatar(agentId))
  return { filename, randomize }
}
