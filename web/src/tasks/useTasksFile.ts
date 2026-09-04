import { useCallback, useEffect, useRef, useState } from 'react'

import { getWorkspaceTasks, saveWorkspaceTasks, TasksConflictError } from '../api.js'
import {
  appendChildTaskAtLine,
  deleteTaskLine,
  toggleTaskLine,
  updateTaskTextAtLine,
} from './task-markdown.js'

const toTasksSocketUrl = (workspaceId: string) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/tasks/${workspaceId}`
}

const shouldIgnoreRemoteUpdate = (
  nextContent: string,
  savedContent: string,
  currentContent: string
) => nextContent === savedContent || nextContent === currentContent

export const useTasksFile = (workspaceId: string | null) => {
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [hasConflict, setHasConflict] = useState(false)
  const [remoteContent, setRemoteContent] = useState<string | null>(null)
  const dirtyRef = useRef(false)
  const savedContentRef = useRef('')
  const contentRef = useRef('')
  // Last revision this client knows was actually on disk — sent as
  // expectedRevision on every save so the server can reject (409) a write
  // based on a stale copy instead of silently clobbering a concurrent edit
  // (e.g. an agent's own tasks.md write landing between our load and save).
  const revisionRef = useRef<string | undefined>(undefined)
  const remoteRevisionRef = useRef<string | undefined>(undefined)

  const applyRemoteContent = useCallback(
    (nextContent: string, currentContent: string, revision: string | undefined) => {
      if (!dirtyRef.current) {
        savedContentRef.current = nextContent
        contentRef.current = nextContent
        revisionRef.current = revision
        setContent(nextContent)
        setHasConflict(false)
        setRemoteContent(null)
        return
      }
      if (shouldIgnoreRemoteUpdate(nextContent, savedContentRef.current, currentContent)) {
        return
      }
      remoteRevisionRef.current = revision
      setRemoteContent(nextContent)
      setHasConflict(true)
    },
    []
  )

  useEffect(() => {
    if (!workspaceId) {
      setContent('')
      setLoaded(false)
      setHasConflict(false)
      setRemoteContent(null)
      dirtyRef.current = false
      savedContentRef.current = ''
      contentRef.current = ''
      return
    }
    let cancelled = false
    setContent('')
    setLoaded(false)
    setHasConflict(false)
    setRemoteContent(null)
    dirtyRef.current = false
    savedContentRef.current = ''
    contentRef.current = ''
    void getWorkspaceTasks(workspaceId)
      .then(({ content: nextContent, revision }) => {
        if (cancelled) return
        savedContentRef.current = nextContent
        dirtyRef.current = false
        contentRef.current = nextContent
        revisionRef.current = revision
        setContent(nextContent)
        setLoaded(true)
        setHasConflict(false)
        setRemoteContent(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        savedContentRef.current = ''
        dirtyRef.current = false
        contentRef.current = ''
        setContent('')
        setLoaded(true)
        setHasConflict(false)
        console.error('[gachi] swallowed:tasks.initialLoad', error)
        setRemoteContent(null)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) return
    let stopped = false
    let socket: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    const RECONNECT_BASE_DELAY_MS = 500
    const RECONNECT_MAX_DELAY_MS = 10_000
    const nextDelay = () => Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt)

    const connect = () => {
      if (stopped) return
      const nextSocket = new WebSocket(toTasksSocketUrl(workspaceId))
      socket = nextSocket
      nextSocket.onopen = () => {
        attempt = 0
      }
      nextSocket.onmessage = (event) => {
        if (stopped) return
        const payload = JSON.parse(event.data) as {
          content?: string
          revision?: string
          type: string
        }
        if (payload.type !== 'tasks-snapshot' && payload.type !== 'tasks-updated') return
        if (typeof payload.content !== 'string') return
        applyRemoteContent(payload.content, contentRef.current, payload.revision)
      }
      // Reconnects on any close (server restart, dropped connection, network
      // blip) — without this the client silently stops receiving live
      // tasks.md updates until something else remounts this hook.
      nextSocket.onclose = () => {
        if (stopped) return
        const delay = nextDelay()
        attempt += 1
        reconnectTimer = setTimeout(connect, delay)
      }
      nextSocket.onerror = () => {
        nextSocket.close()
      }
    }

    connect()

    return () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [applyRemoteContent, workspaceId])

  // Saves `next`, guarded by the last known-good revision. On a 409 the
  // optimistic local write is rolled back to `previous` and the server's
  // current content surfaces through the existing conflict dialog
  // (hasConflict/remoteContent) instead of silently overwriting it.
  const saveGuarded = async (workspaceIdValue: string, previous: string, next: string) => {
    try {
      const response = await saveWorkspaceTasks(workspaceIdValue, {
        content: next,
        ...(revisionRef.current !== undefined ? { expectedRevision: revisionRef.current } : {}),
      })
      savedContentRef.current = response.content
      contentRef.current = response.content
      revisionRef.current = response.revision
      setContent(response.content)
      setHasConflict(false)
      setRemoteContent(null)
    } catch (error) {
      savedContentRef.current = previous
      contentRef.current = previous
      setContent(previous)
      if (error instanceof TasksConflictError) {
        remoteRevisionRef.current = error.current.revision
        setRemoteContent(error.current.content)
        setHasConflict(true)
      }
      throw error
    }
  }

  const saveWithRebase = async (workspaceIdValue: string, previous: string, next: string) => {
    try {
      await saveGuarded(workspaceIdValue, previous, next)
    } catch (error) {
      // Benign conflict: the disk moved past our revision but its content is
      // byte-identical to the base we edited from — nothing to lose. Re-apply
      // the same change on the fresh revision instead of staging a conflict
      // dialog for a no-op divergence.
      if (error instanceof TasksConflictError && error.current.content === previous) {
        await saveGuarded(workspaceIdValue, error.current.content, next)
        return
      }
      throw error
    }
  }

  const persistTransform = async (
    transform: (current: string) => string,
    operationLabel: string
  ) => {
    if (!workspaceId) return
    const previous = contentRef.current
    const next = transform(previous)
    if (next === previous) return
    savedContentRef.current = next
    contentRef.current = next
    dirtyRef.current = false
    setContent(next)
    try {
      await saveWithRebase(workspaceId, previous, next)
    } catch (error) {
      console.error(`[gachi] swallowed:tasks.${operationLabel}`, error)
      throw error
    }
  }

  return {
    content,
    hasConflict,
    loaded,
    onChange: (value: string) => {
      dirtyRef.current = value !== savedContentRef.current
      contentRef.current = value
      setContent(value)
    },
    onKeepLocal: () => {
      // The user is choosing to keep editing against their own copy — adopt
      // the conflicting revision as our new baseline so the next save wins
      // instead of 409ing again against the same stale expectedRevision.
      revisionRef.current = remoteRevisionRef.current
      setHasConflict(false)
      setRemoteContent(null)
    },
    onReload: () => {
      const nextContent = remoteContent ?? savedContentRef.current
      savedContentRef.current = nextContent
      dirtyRef.current = false
      contentRef.current = nextContent
      revisionRef.current = remoteRevisionRef.current
      setContent(nextContent)
      setHasConflict(false)
      setRemoteContent(null)
    },
    onSave: async () => {
      if (!workspaceId) return
      await saveWithRebase(workspaceId, savedContentRef.current, content)
      dirtyRef.current = false
    },
    toggleTaskAtLine: async (lineIndex: number) => {
      if (!workspaceId) return
      const previous = contentRef.current
      const next = toggleTaskLine(previous, lineIndex)
      if (next === previous) return
      savedContentRef.current = next
      contentRef.current = next
      dirtyRef.current = false
      setContent(next)
      await saveGuarded(workspaceId, previous, next)
    },
    appendTask: async (text: string) => {
      const trimmed = text.trim()
      if (!workspaceId || !trimmed) return
      const previous = contentRef.current
      const needsLeadingNewline = previous.length > 0 && !previous.endsWith('\n')
      const next = `${previous}${needsLeadingNewline ? '\n' : ''}- [ ] ${trimmed}\n`
      savedContentRef.current = next
      contentRef.current = next
      dirtyRef.current = false
      setContent(next)
      await saveGuarded(workspaceId, previous, next)
    },
    appendSubtask: async (parentLine: number, text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      await persistTransform(
        (current) => appendChildTaskAtLine(current, parentLine, trimmed),
        'appendSubtask'
      )
    },
    updateTaskText: async (lineIndex: number, nextText: string) => {
      const trimmed = nextText.trim()
      if (!trimmed) return
      await persistTransform(
        (current) => updateTaskTextAtLine(current, lineIndex, trimmed),
        'updateTaskText'
      )
    },
    deleteTask: async (lineIndex: number) => {
      await persistTransform((current) => deleteTaskLine(current, lineIndex), 'deleteTask')
    },
  }
}
