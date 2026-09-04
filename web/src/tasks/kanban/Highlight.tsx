import { findMatchRanges } from './kanban-model.js'

interface HighlightProps {
  text: string
  query: string
}

/** Renders text with all query matches wrapped in a yellow highlight. */
export const Highlight = ({ text, query }: HighlightProps) => {
  const ranges = findMatchRanges(text, query)
  if (ranges.length === 0) return <>{text}</>

  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start))
    parts.push(
      <mark key={start} className="kb-mark">
        {text.slice(start, end)}
      </mark>
    )
    cursor = end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}
