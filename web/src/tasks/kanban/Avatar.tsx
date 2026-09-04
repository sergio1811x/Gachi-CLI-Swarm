import type { TeamListItem } from '../../../../src/shared/types.js'

const hueFor = (name: string): number => {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return hash % 360
}

const initialsFor = (name: string): string => {
  const parts = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
  if (parts.length === 0 || !parts[0]) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  const first = parts[0][0]
  const lastPart = parts[parts.length - 1]
  if (first === undefined || !lastPart) return '?'
  return (first + lastPart[0]).toUpperCase()
}

interface AvatarProps {
  name: string
  className?: string
}

export const Avatar = ({ name, className }: AvatarProps) => {
  const hue = hueFor(name)
  return (
    <span
      className={`kb-avatar ${className ?? ''}`}
      style={{
        background: `hsl(${hue} 40% 26%)`,
        color: `hsl(${hue} 85% 80%)`,
      }}
      aria-hidden="true"
    >
      {initialsFor(name)}
    </span>
  )
}

interface WorkerTipProps {
  worker: TeamListItem | undefined
  children: React.ReactNode
}

/** Wraps an @mention with a rich hover tooltip (avatar + role). */
export const WorkerTip = ({ worker, children }: WorkerTipProps) => {
  return (
    <span className="kb-tip" tabIndex={-1}>
      {children}
      {worker && (
        <span className="kb-tip-pop">
          <Avatar name={worker.name} />
          <span>@{worker.name}</span>
          <span className="kb-tip-role">· {worker.role}</span>
        </span>
      )}
    </span>
  )
}
