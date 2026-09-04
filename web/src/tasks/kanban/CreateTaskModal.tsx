import { X } from 'lucide-react'
import { useState } from 'react'

interface CreateTaskModalProps {
  workers: readonly { id: string; name: string; role: string }[]
  submitting: boolean
  error?: string | null
  onClose: () => void
  onSubmit: (input: { title: string; description: string; workerId: string }) => Promise<void>
}

export const CreateTaskModal = ({
  workers,
  submitting,
  error,
  onClose,
  onSubmit,
}: CreateTaskModalProps) => {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [workerId, setWorkerId] = useState('')

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; the dialog card inside is the interactive surface
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape-to-close is handled globally by KanbanBoard's keydown listener
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      style={{ background: 'rgba(0, 0, 0, 0.75)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation keeps backdrop clicks from closing the dialog */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users close via Escape or the Cancel button */}
      <div
        className="rounded-2xl max-w-lg w-full p-6 shadow-2xl animate-in fade-in-50 zoom-in-95 duration-150"
        style={{
          background: 'var(--bg-1)',
          border: '1px solid var(--border)',
          boxShadow: '0 25px 60px rgba(0, 0, 0, 0.9)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-bold text-pri">Создать задачу на Канбан-доске</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-sec hover:text-pri"
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!title.trim() || submitting) return
            void onSubmit({ title: title.trim(), description: description.trim(), workerId })
              .then(() => {
                setTitle('')
                setDescription('')
                setWorkerId('')
              })
              .catch(() => {})
          }}
          className="space-y-4"
        >
          <div>
            <label
              htmlFor="kanban-create-task-title"
              className="block text-xs font-semibold text-sec mb-1.5"
            >
              Название задачи <span className="text-red-400">*</span>
            </label>
            <input
              id="kanban-create-task-title"
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Реализовать эндпоинт /auth/login..."
              className="w-full text-xs rounded-lg px-3.5 py-2.5 text-pri focus:outline-none"
              style={{ background: 'var(--bg-0)', border: '1px solid var(--border)' }}
            />
          </div>

          <div>
            <label
              htmlFor="kanban-create-task-desc"
              className="block text-xs font-semibold text-sec mb-1.5"
            >
              Описание и требования
            </label>
            <textarea
              id="kanban-create-task-desc"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Детали, критерии готовности, файлы..."
              className="w-full text-xs rounded-lg px-3.5 py-2.5 text-pri focus:outline-none resize-none"
              style={{ background: 'var(--bg-0)', border: '1px solid var(--border)' }}
            />
          </div>

          <div>
            <label
              htmlFor="kanban-create-task-worker"
              className="block text-xs font-semibold text-sec mb-1.5"
            >
              Назначить воркера сразу (опционально)
            </label>
            <select
              id="kanban-create-task-worker"
              value={workerId}
              onChange={(e) => setWorkerId(e.target.value)}
              className="w-full text-xs rounded-lg px-3.5 py-2.5 text-pri focus:outline-none"
              style={{ background: 'var(--bg-0)', border: '1px solid var(--border)' }}
            >
              <option value="">Без назначения (в колонку Бэклог)</option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  @{w.name} ({w.role})
                </option>
              ))}
            </select>
          </div>

          {error && (
            <p className="text-xs" style={{ color: '#ef4444' }}>
              {error}
            </p>
          )}

          <div
            className="flex items-center justify-end gap-2.5 pt-4"
            style={{ borderTop: '1px solid var(--border)' }}
          >
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs text-sec hover:text-pri rounded-lg transition-colors cursor-pointer"
              style={{ background: 'var(--bg-0)', border: '1px solid var(--border)' }}
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={!title.trim() || submitting}
              className="px-5 py-2 text-xs text-white rounded-lg font-semibold disabled:opacity-50 transition-opacity cursor-pointer"
              style={{ background: 'var(--accent)' }}
            >
              Создать
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default CreateTaskModal
