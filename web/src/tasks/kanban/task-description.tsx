import { Check, ChevronDown, Copy } from 'lucide-react'
import { type ReactNode, useState } from 'react'

/**
 * Markdown-lite block renderer for task descriptions.
 *
 * Workers emit free-form prompts with a handful of recurring shapes:
 * `##` headings, `-`/`•` bullet lists, fenced code blocks, hex colors
 * (`#FFD60A`), POSIX file paths (`by_channel/x/prompts.md`) and warning
 * lines (`⚠️ …`). This renderer styles those and passes everything else
 * through as plain text — same philosophy as inline-markdown.tsx, but for
 * multi-line documents. No HTML is ever parsed; React escapes strings.
 */

type CodeBlock = { type: 'code'; lang: string; content: string }
type HeadingBlock = { type: 'heading'; level: number; text: string }
type ListBlock = { type: 'list'; items: string[] }
type ParaBlock = { type: 'para'; text: string }
type DescriptionBlock = CodeBlock | HeadingBlock | ListBlock | ParaBlock

const WARNING_RE = /^\s*(⚠️|❗|‼️|\bВАЖНО\s*:|\bВНИМАНИЕ\s*:)/i

const parseBlocks = (text: string): DescriptionBlock[] => {
  const lines = text.split('\n')
  const blocks: DescriptionBlock[] = []
  let para: string[] = []
  let list: string[] | null = null
  let code: { lang: string; lines: string[] } | null = null

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ type: 'para', text: para.join('\n') })
      para = []
    }
  }
  const flushList = () => {
    if (list && list.length > 0) blocks.push({ type: 'list', items: list })
    list = null
  }

  for (const line of lines) {
    const fence = line.match(/^```(\S*)\s*$/)
    if (fence) {
      if (code) {
        blocks.push({ type: 'code', lang: code.lang, content: code.lines.join('\n') })
        code = null
      } else {
        flushPara()
        flushList()
        code = { lang: fence[1] ?? '', lines: [] }
      }
      continue
    }
    if (code) {
      code.lines.push(line)
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    const headingLevel = heading?.[1]?.length
    const headingText = heading?.[2]
    if (headingLevel !== undefined && headingText !== undefined) {
      flushPara()
      flushList()
      blocks.push({ type: 'heading', level: headingLevel, text: headingText.trim() })
      continue
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    const bulletText = bullet?.[1]
    if (bulletText !== undefined) {
      flushPara()
      list ??= []
      list.push(bulletText)
      continue
    }
    if (!line.trim()) {
      flushPara()
      flushList()
      continue
    }
    if (list) {
      // Continuation line inside a list item keeps the list together.
      list[list.length - 1] += ` ${line.trim()}`
      continue
    }
    para.push(line)
  }
  if (code) blocks.push({ type: 'code', lang: code.lang, content: code.lines.join('\n') })
  flushPara()
  flushList()
  return blocks
}

const HEX_RE = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/
const PATH_RE = /[\w@+.-]+(?:\/[\w@+.-]+)+\.[A-Za-z0-9]{1,8}/
const CODE_RE = /`([^`]+?)`/
const BOLD_RE = /\*\*([^*]+?)\*\*/
const ITALIC_RE = /\*([^*]+?)\*/

/** Hex color chip — tinted with the actual color + permanent mini-swatch. */
const HexChip = ({ hex }: { hex: string }) => (
  <span
    className="mono inline-flex translate-y-[1px] items-center gap-1 rounded px-1.5 py-px"
    style={{
      fontSize: '12px',
      color: hex,
      background: `${hex}1a`,
      border: `1px solid ${hex}4d`,
    }}
    title={hex}
  >
    <span
      aria-hidden
      className="inline-block h-3 w-3 shrink-0 rounded-sm"
      style={{ background: hex, border: '1px solid rgba(255,255,255,0.25)' }}
    />
    {hex}
  </span>
)

const PathSpan = ({ path }: { path: string }) => (
  <span className="mono cursor-text text-[12px] text-status-blue hover:underline" title={path}>
    {path}
  </span>
)

const InlineCode = ({ value }: { value: string }) => (
  <code
    className="mono rounded px-1 py-px text-[12px]"
    style={{ background: 'var(--bg-3)', border: '1px solid var(--border)' }}
  >
    {value}
  </code>
)

/** Inline pass: code → bold → italic → hex → path, everything else literal. */
export const renderDescriptionInline = (text: string): ReactNode[] => {
  const nodes: ReactNode[] = []
  let buffer = ''
  let key = 0
  const flush = () => {
    if (buffer) {
      nodes.push(buffer)
      buffer = ''
    }
  }
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    const tryMatch = (re: RegExp) => {
      const m = rest.match(re)
      return m && m.index === 0 ? m : null
    }
    const code = tryMatch(CODE_RE)
    if (code?.[1]) {
      flush()
      nodes.push(<InlineCode key={key++} value={code[1]} />)
      i += code[0].length
      continue
    }
    const bold = tryMatch(BOLD_RE)
    if (bold?.[1]) {
      flush()
      nodes.push(<strong key={key++}>{renderDescriptionInline(bold[1])}</strong>)
      i += bold[0].length
      continue
    }
    const italic = tryMatch(ITALIC_RE)
    if (italic?.[1]) {
      flush()
      nodes.push(<em key={key++}>{renderDescriptionInline(italic[1])}</em>)
      i += italic[0].length
      continue
    }
    const hex = tryMatch(HEX_RE)
    if (hex?.[1]) {
      flush()
      nodes.push(<HexChip key={key++} hex={`#${hex[1]}`} />)
      i += hex[0].length
      continue
    }
    const path = tryMatch(PATH_RE)
    if (path) {
      flush()
      nodes.push(<PathSpan key={key++} path={path[0]} />)
      i += path[0].length
      continue
    }
    buffer += text[i]
    i += 1
  }
  flush()
  return nodes
}

/** Visible budget per unique paragraph before repeats collapse (spec §9). */
const DUPLICATE_BUDGET = 2

const blockKey = (block: DescriptionBlock): string => {
  switch (block.type) {
    case 'code':
      return `code:${block.content}`
    case 'heading':
      return `h:${block.text}`
    case 'list':
      return `li:${block.items.join('\n')}`
    case 'para':
      return `p:${block.text}`
  }
}

const BlockBody = ({ block }: { block: DescriptionBlock }) => {
  switch (block.type) {
    case 'heading': {
      const size =
        block.level <= 2 ? 'text-sm font-semibold text-pri' : 'text-[13px] font-semibold text-pri'
      return (
        <div className={`${size} mt-5 mb-2 first:mt-0 font-display`}>
          {renderDescriptionInline(block.text)}
        </div>
      )
    }
    case 'list': {
      // Content + occurrence suffix: bullets can repeat verbatim inside one
      // list, so a bare content key would collide.
      const seenItems = new Map<string, number>()
      const keyedItems = block.items.map((item) => {
        const n = (seenItems.get(item) ?? 0) + 1
        seenItems.set(item, n)
        return { key: n > 1 ? `${n}:${item}` : item, item }
      })
      return (
        <ul className="my-2 space-y-1 pl-4">
          {keyedItems.map(({ key, item }) => (
            <li key={key} className="flex gap-2 leading-relaxed">
              <span aria-hidden className="mt-px shrink-0 text-accent">
                •
              </span>
              <span>{renderDescriptionInline(item)}</span>
            </li>
          ))}
        </ul>
      )
    }
    case 'para': {
      const isWarning = WARNING_RE.test(block.text)
      if (isWarning) {
        return (
          <div
            className="my-2 rounded-r-lg px-3.5 py-2.5 text-pri leading-relaxed"
            style={{
              background: 'color-mix(in oklab, var(--status-red) 8%, transparent)',
              borderLeft: '3px solid var(--status-red)',
            }}
          >
            {renderDescriptionInline(block.text)}
          </div>
        )
      }
      return (
        <p className="my-2 whitespace-pre-wrap leading-relaxed">
          {renderDescriptionInline(block.text)}
        </p>
      )
    }
    case 'code':
      return <CodeBlockView content={block.content} />
  }
}

const CodeBlockView = ({ content }: { content: string }) => {
  const [copied, setCopied] = useState(false)
  return (
    <div
      className="group/code relative my-2 overflow-hidden rounded-lg"
      style={{ background: 'var(--bg-0)', border: '1px solid var(--border)' }}
    >
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(content)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }}
        title="Скопировать код"
        className="absolute right-2 top-2 flex items-center gap-1 rounded px-1.5 py-1 text-ter opacity-0 transition-opacity group-hover/code:opacity-100 hover:text-pri"
        style={{ background: 'var(--bg-2)' }}
      >
        {copied ? <Check className="h-3 w-3 text-status-green" /> : <Copy className="h-3 w-3" />}
      </button>
      <pre className="mono overflow-x-auto p-3 text-[12px] leading-relaxed text-sec select-text">
        {content}
      </pre>
    </div>
  )
}

/**
 * Renders the description with duplicate-paragraph collapsing: after the
 * second occurrence of an identical block, further copies are hidden behind
 * a single expander instead of re-rendering the same wall of text.
 */
export const TaskDescriptionBody = ({ description }: { description: string }) => {
  const [showRepeats, setShowRepeats] = useState(false)

  const computed = (() => {
    const blocks = parseBlocks(description)
    const counts = new Map<string, number>()
    for (const block of blocks) {
      const key = blockKey(block)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const seen = new Map<string, number>()
    let hiddenCount = 0
    const rendered = blocks.map((block) => {
      const key = blockKey(block)
      const nth = (seen.get(key) ?? 0) + 1
      seen.set(key, nth)
      if ((counts.get(key) ?? 1) > DUPLICATE_BUDGET && nth > DUPLICATE_BUDGET) {
        hiddenCount += 1
        return showRepeats ? (
          <div key={`${key}#${nth}`} className="opacity-70">
            <BlockBody block={block} />
          </div>
        ) : null
      }
      return <BlockBody key={`${key}#${nth}`} block={block} />
    })
    return { rendered, hiddenCount }
  })()

  return (
    <div className="text-[13px] text-pri">
      {computed.rendered}
      {computed.hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowRepeats((cur) => !cur)}
          className="mt-3 flex items-center gap-1 text-xs text-ter transition-colors hover:text-pri"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${showRepeats ? 'rotate-180' : ''}`}
          />
          <span>
            {showRepeats
              ? 'Скрыть повторы'
              : `Показать ещё ${computed.hiddenCount} повтор${computed.hiddenCount === 1 ? '' : computed.hiddenCount < 5 ? 'а' : 'ов'}`}
          </span>
        </button>
      )}
    </div>
  )
}
