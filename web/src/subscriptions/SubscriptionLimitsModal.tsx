import { CheckCircle2, RefreshCw, X, Zap } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { fetchSubscriptionLimits, type ProviderSubscriptionLimit } from '../api.js'

interface SubscriptionLimitsModalProps {
  isOpen: boolean
  onClose: () => void
}

export const SubscriptionLimitsModal = ({ isOpen, onClose }: SubscriptionLimitsModalProps) => {
  const [limits, setLimits] = useState<ProviderSubscriptionLimit[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadLimits = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await fetchSubscriptionLimits()
      setLimits(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить лимиты')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen) {
      void loadLimits()
    }
  }, [isOpen, loadLimits])

  if (!isOpen) return null

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: full-bleed backdrop; Escape below and the panel's close button cover keyboard paths
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      role="presentation"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: clicks stop here only for panel bubbling; Escape is handled on the backdrop */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: panel stops click bubbling only; Escape lives on the backdrop */}
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-2xl rounded-xl border border-[var(--border)] p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150 flex flex-col gap-5 text-pri max-h-[90vh] overflow-y-auto"
        style={{
          backgroundColor: 'var(--bg-1)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.75)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка */}
        <div className="flex items-center justify-between border-b border-[var(--border)] pb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/30">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold">Статус подписок & CLI окружение</h2>
              <p className="text-xs text-ter">
                Проверка авторизации, подписок и готовности локальных CLI-агентов
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadLimits()}
              disabled={isLoading}
              className="p-1.5 rounded-md hover:bg-[var(--bg-2)] text-sec hover:text-pri transition-colors"
              title="Обновить статус"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-[var(--bg-2)] text-sec hover:text-pri transition-colors"
              title="Закрыть"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Ошибка если есть */}
        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
            {error}
          </div>
        )}

        {/* Сетка провайдеров */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {limits.map((provider) => {
            const isConfigured = provider.status === 'active'

            return (
              <div
                key={provider.id}
                className="rounded-xl border border-[var(--border)] p-4 flex flex-col gap-3 bg-[var(--bg-0)]/70 hover:border-[var(--border-strong)] transition-all"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-md bg-[var(--bg-2)] flex items-center justify-center font-bold text-xs">
                      {provider.id === 'claude' && <span className="text-amber-400">CC</span>}
                      {provider.id === 'codex' && <span className="text-emerald-400">OX</span>}
                      {provider.id === 'agy' && <span className="text-blue-400">AG</span>}
                      {provider.id === 'opencode' && <span className="text-purple-400">OC</span>}
                    </div>
                    <div>
                      <div className="font-semibold text-sm leading-tight">{provider.name}</div>
                      <div className="text-[11px] text-ter">{provider.tier}</div>
                    </div>
                  </div>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${
                      isConfigured
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        : 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30'
                    }`}
                  >
                    {isConfigured ? '✓ Активен' : 'Не настроен'}
                  </span>
                </div>

                {/* Статус авторизации и готовности */}
                <div className="flex items-center justify-between text-xs py-1 px-2.5 rounded-lg bg-[var(--bg-1)] border border-[var(--border)]">
                  <div className="flex items-center gap-1.5 text-sec">
                    <span
                      className={`w-2 h-2 rounded-full ${isConfigured ? 'bg-emerald-400' : 'bg-zinc-500'}`}
                    />
                    <span>{provider.authStatus}</span>
                  </div>
                  <span className="font-medium text-pri text-[11px]">{provider.availability}</span>
                </div>

                {/* Описание конфигурации */}
                <div className="text-[11px] text-ter leading-relaxed pt-1 border-t border-[var(--border)] mt-auto">
                  {provider.details}
                </div>
              </div>
            )
          })}
        </div>

        {/* Подвал с подсказкой */}
        <div className="rounded-lg bg-[var(--bg-0)] p-3 border border-[var(--border)] flex items-start gap-2.5 text-xs text-sec">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold text-pri">Балансировка воркеров: </span>
            <span>
              При исчерпании лимитов на одном CLI-провайдере переключайте воркеров на другие
              настроенные CLI прямо в настройках команды без потери контекста.
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
