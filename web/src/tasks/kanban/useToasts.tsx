import { AlertCircle, CheckCircle2, Info } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

export type ToastTone = 'info' | 'error' | 'success'

export interface ToastAction {
  label: string
  run: () => void
}

export interface ToastItem {
  id: number
  message: string
  tone: ToastTone
  action?: ToastAction
}

const TONE_ICONS = {
  info: Info,
  error: AlertCircle,
  success: CheckCircle2,
} as const

export const useToasts = () => {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timersRef = useRef(new Map<number, number>())
  const seqRef = useRef(0)

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setToasts((cur) => cur.filter((t) => t.id !== id))
  }, [])

  /** Shows a toast; returns its id so callers can dismiss it programmatically. */
  const show = useCallback(
    (
      message: string,
      tone: ToastTone = 'info',
      opts?: { duration?: number; action?: ToastAction }
    ): number => {
      const id = ++seqRef.current
      setToasts((cur) => [
        ...cur.slice(-3),
        { id, message, tone, ...(opts?.action ? { action: opts.action } : {}) },
      ])
      timersRef.current.set(
        id,
        window.setTimeout(() => dismiss(id), opts?.duration ?? 2500)
      )
      return id
    },
    [dismiss]
  )

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
    }
  }, [])

  return { toasts, show, dismiss }
}

interface ToastStackProps {
  toasts: ToastItem[]
  onDismiss: (id: number) => void
}

export const ToastStack = ({ toasts, onDismiss }: ToastStackProps) => {
  if (toasts.length === 0) return null
  return (
    <div className="kb-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = TONE_ICONS[toast.tone]
        const color =
          toast.tone === 'error' ? '#ef4444' : toast.tone === 'success' ? '#22c55e' : '#8a8a8a'
        return (
          <div key={toast.id} className={`kb-toast kb-toast--${toast.tone}`}>
            <Icon size={14} style={{ color, flexShrink: 0 }} />
            <span className="kb-toast-msg">{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                className="kb-toast-action"
                onClick={() => {
                  toast.action?.run()
                  onDismiss(toast.id)
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
