import { useState } from 'react'
import { SubscriptionLimitsModal } from './SubscriptionLimitsModal.js'

export const SubscriptionLimitsButton = () => {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <>
      {/*<Tooltip content="Квоты и лимиты подписок CLI (Claude Code, OpenAI Codex, Google AGY, OpenCode)">*/}
      {/*  <button*/}
      {/*    type="button"*/}
      {/*    onClick={() => setIsOpen(true)}*/}
      {/*    className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md bg-[var(--bg-1)] hover:bg-[var(--bg-2)] border border-[var(--border)] text-sec hover:text-pri font-medium transition-all shadow-sm"*/}
      {/*  >*/}
      {/*    <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400/20" />*/}
      {/*    <span className="font-medium">Лимиты CLI</span>*/}
      {/*    <span className="w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-emerald-400/20 animate-pulse" />*/}
      {/*  </button>*/}
      {/*</Tooltip>*/}

      <SubscriptionLimitsModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  )
}
