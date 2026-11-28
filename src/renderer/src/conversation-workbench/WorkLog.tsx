import { useId, useState, type ComponentProps, type JSX, type ReactNode } from 'react'
import {
  Brain,
  ChevronRight,
  CircleAlert,
  CircleMinus,
  FileText,
  Globe,
  Layers,
  LoaderCircle,
  Pencil,
  Terminal,
  Wrench,
} from 'lucide-react'
import { clsx } from 'clsx'
import type { ConversationTimelineWorkEntry } from './useConversationThread'

type RowContent = {
  icon?: ReactNode
  label: ReactNode
  chip?: ReactNode
  chipMono?: boolean
  meta?: ReactNode
  wrapLabel?: boolean
}

type LineProps = Omit<ComponentProps<'div'>, 'className' | 'style' | 'children'>

export type ToolCategory = 'artifact' | 'command' | 'search' | 'file' | 'edit' | 'tool'

export function classifyWorkEntry(entry: Pick<ConversationTimelineWorkEntry, 'toolName' | 'text'>): ToolCategory {
  const source = `${entry.toolName ?? ''} ${entry.text}`.toLowerCase()
  if (/\bartifact\b|artifactdata|artifactcomments|产物/.test(source)) return 'artifact'
  if (/运行命令|\b(?:exec|shell|bash|command|terminal|pwsh|powershell|run_command)\b/.test(source)) return 'command'
  if (/web_search|搜索网页|\b(?:search|grep|find|web|fetch)\b/.test(source)) return 'search'
  if (/修改文件|写入|\b(?:write|edit|patch|diff)\b/.test(source)) return 'edit'
  if (/查看图片|读取|\b(?:read|file|image)\b/.test(source)) return 'file'
  return 'tool'
}

function categoryIcon(category: ToolCategory): JSX.Element {
  if (category === 'artifact') return <Layers size={14} aria-hidden="true" />
  if (category === 'command') return <Terminal size={14} aria-hidden="true" />
  if (category === 'search') return <Globe size={14} aria-hidden="true" />
  if (category === 'edit') return <Pencil size={14} aria-hidden="true" />
  if (category === 'file') return <FileText size={14} aria-hidden="true" />
  return <Wrench size={14} aria-hidden="true" />
}

export function workEntryIcon(entry: ConversationTimelineWorkEntry): JSX.Element {
  if (entry.state === 'running') {
    return <LoaderCircle size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
  }
  if (entry.state === 'failed') return <CircleAlert size={13} aria-hidden="true" />
  if (entry.state === 'cancelled') return <CircleMinus size={13} aria-hidden="true" />
  return categoryIcon(classifyWorkEntry(entry))
}

const CATEGORY_PRIORITY: Record<ToolCategory, number> = {
  edit: 0,
  command: 1,
  artifact: 2,
  search: 3,
  file: 4,
  tool: 5,
}

function formatCategoryClause(category: ToolCategory, count: number): string {
  switch (category) {
    case 'edit':
      return `已更改 ${count} 个文件`
    case 'command':
      return `已运行 ${count} 条命令`
    case 'artifact':
      return `已执行 ${count} 项产物操作`
    case 'search':
      return `已搜索 ${count} 次`
    case 'file':
      return `已查看 ${count} 个文件`
    case 'tool':
      return `已执行 ${count} 项操作`
  }
}

function joinChineseClauses(clauses: readonly string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? ''
  if (clauses.length === 2) return `${clauses[0]}，${clauses[1]}`
  return `${clauses.slice(0, -1).join('、')}和${clauses[clauses.length - 1]}`
}

export function summarizeWorkEntries(entries: readonly ConversationTimelineWorkEntry[]): {
  readonly summary: string
  readonly category: ToolCategory
  readonly hasFailure: boolean
} {
  const counts = new Map<ToolCategory, number>()
  let hasFailure = false
  for (const entry of entries) {
    if (entry.state === 'failed') hasFailure = true
    const cat = classifyWorkEntry(entry)
    counts.set(cat, (counts.get(cat) ?? 0) + 1)
  }
  const ordered = [...counts.entries()].sort(
    ([catA], [catB]) => CATEGORY_PRIORITY[catA] - CATEGORY_PRIORITY[catB],
  )
  const primaryCategory = ordered[0]?.[0] ?? 'tool'
  const top = ordered.slice(0, 3).map(([cat, count]) => formatCategoryClause(cat, count))
  return {
    summary: joinChineseClauses(top) || `${entries.length} 次工具调用`,
    category: primaryCategory,
    hasFailure,
  }
}

export function extractReasoningHeadline(text: string): string {
  const cleaned = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean)
  if (!cleaned) return '思考过程'
  return cleaned
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\*{1,2}([^*]+)\*{1,2}$/, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim() || '思考过程'
}

const STATE_LABELS: Record<ConversationTimelineWorkEntry['state'], string> = {
  running: '进行中',
  done: '已完成',
  failed: '未通过',
  cancelled: '已取消',
}

interface CompactWorkItem {
  readonly id: string
  readonly entry: ConversationTimelineWorkEntry
  readonly count: number
}

/**
 * Consecutive bare work entries (legacy logs without command/arg detail) with the exact same
 * label and state collapse into one tidy row (`运行命令 [4 次]`) instead of repeating 10 identical lines.
 */
function compactWorkEntries(entries: readonly ConversationTimelineWorkEntry[]): readonly CompactWorkItem[] {
  const result: CompactWorkItem[] = []
  for (const entry of entries) {
    const prev = result.at(-1)
    if (
      prev &&
      !entry.detail &&
      !prev.entry.detail &&
      !entry.output &&
      !prev.entry.output &&
      entry.exitCode === undefined &&
      prev.entry.exitCode === undefined &&
      entry.state !== 'running' &&
      prev.entry.state === entry.state &&
      prev.entry.text === entry.text
    ) {
      result[result.length - 1] = { ...prev, count: prev.count + 1 }
    } else {
      result.push({ id: entry.id, entry, count: 1 })
    }
  }
  return result
}

function WorkLogLine({ icon, label, chip, chipMono, meta, wrapLabel }: RowContent) {
  return (
    <div className="conversation-work-line">
      <div className={clsx('conversation-work-label', wrapLabel && 'conversation-work-label-wrap')}>
        {icon ? (
          <span className="conversation-work-icon">
            <span>{icon}</span>
          </span>
        ) : null}
        <span className="conversation-work-text">{label}</span>
        {chip ? (
          <span
            className={clsx('conversation-work-arg-chip', chipMono && 'conversation-work-arg-chip-mono')}
            title={typeof chip === 'string' ? chip : undefined}
          >
            {chip}
          </span>
        ) : null}
        {meta ? <span className="conversation-work-meta">{meta}</span> : null}
      </div>
    </div>
  )
}

export function WorkLogRow({ icon, label, chip, chipMono, meta, wrapLabel = false, ...rowProps }: RowContent & LineProps) {
  return (
    <div {...rowProps} className="conversation-work-row">
      <WorkLogLine icon={icon} label={label} chip={chip} chipMono={chipMono} meta={meta} wrapLabel={wrapLabel} />
    </div>
  )
}

const SHELL_DETAIL_PREFIX = /^(?:["']?(?:(?:[a-z]:[\\/]+|\/)?(?:[^\r\n"']*[\\/])?)?(?:pwsh|powershell)(?:\.exe)?["']?(?:\s+-(?:nologo|noprofile|noninteractive|sta|mta|executionpolicy\s+\S+))*\s+-(?:c|command)\s+|["']?(?:(?:[a-z]:[\\/]+|\/)?(?:[^\r\n"']*[\\/])?)?cmd(?:\.exe)?["']?(?:\s+\/[a-z])*\s+\/c\s+|["']?(?:\/usr\/bin\/env\s+)?(?:\/[^\s"']*\/)?(?:bash|sh|zsh)["']?\s+-[a-z]*c\s+)/i

function sanitizeWorkDetail(entry: ConversationTimelineWorkEntry): string | undefined {
  const raw = entry.detail?.trim()
  if (!raw) return undefined
  if (classifyWorkEntry(entry) !== 'command') return raw
  if (!SHELL_DETAIL_PREFIX.test(raw)) return raw
  const stripped = raw.replace(SHELL_DETAIL_PREFIX, '').trim()
  if (stripped.length >= 2) {
    const first = stripped[0]
    const last = stripped[stripped.length - 1]
    if ((first === '"' || first === "'") && last === first) {
      return stripped.slice(1, -1).replace(/\\"/g, '"').trim() || raw
    }
  }
  if ((stripped.startsWith('"') || stripped.startsWith("'")) && !stripped.slice(1).includes(stripped[0])) {
    return stripped.slice(1).trim() || raw
  }
  return stripped || raw
}

function WorkCommandTaskRow({
  id,
  entry,
  cleanDetail,
  chipText,
  isMono,
}: {
  readonly id: string
  readonly entry: ConversationTimelineWorkEntry
  readonly cleanDetail?: string
  readonly chipText?: string
  readonly isMono: boolean
}): JSX.Element {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const outputId = useId()
  const hasOutput = Boolean(entry.output?.trim())
  const open = manualOpen ?? (entry.state === 'running')
  const metaText = entry.exitCode !== undefined && entry.exitCode !== 0
    ? `退出码 ${entry.exitCode}`
    : entry.state === 'failed'
      ? '未通过'
      : entry.state === 'cancelled'
        ? '已取消'
        : undefined
  return (
    <div className="conversation-work-task-item">
      <WorkLogRow
        key={id}
        data-state={entry.state}
        role="group"
        aria-label={`${entry.text}${cleanDetail ? ` ${cleanDetail}` : ''}，${STATE_LABELS[entry.state]}`}
        label={entry.text}
        chip={chipText}
        chipMono={isMono}
        meta={metaText}
        icon={workEntryIcon(entry)}
      />
      {hasOutput && (
        <>
          <button
            type="button"
            className="conversation-work-output-toggle"
            aria-expanded={open}
            aria-controls={outputId}
            onClick={() => setManualOpen(!open)}
          >
            <span>{open ? '收起输出' : '查看输出'}</span>
          </button>
          {open && (
            <pre id={outputId} className="conversation-work-command-output my-scrollbar">
              {entry.output}
            </pre>
          )}
        </>
      )}
    </div>
  )
}

export function WorkTaskList({ entries }: { readonly entries: readonly ConversationTimelineWorkEntry[] }): JSX.Element {
  const compacted = compactWorkEntries(entries)
  return (
    <div className="conversation-work-task-list">
      {compacted.map(({ id, entry, count }) => {
        const cleanDetail = sanitizeWorkDetail(entry)
        const chipText = cleanDetail ?? (count > 1 ? `${count} 次` : undefined)
        const isMono = Boolean(cleanDetail && (entry.mono || classifyWorkEntry(entry) === 'command'))
        if (entry.output || (entry.exitCode !== undefined && entry.exitCode !== 0)) {
          return (
            <WorkCommandTaskRow
              key={id}
              id={id}
              entry={entry}
              cleanDetail={cleanDetail}
              chipText={chipText}
              isMono={isMono}
            />
          )
        }
        return (
          <WorkLogRow
            key={id}
            data-state={entry.state}
            role="group"
            aria-label={`${entry.text}${cleanDetail ? ` ${cleanDetail}` : ''}，${STATE_LABELS[entry.state]}`}
            label={entry.text}
            chip={chipText}
            chipMono={isMono}
            meta={entry.state === 'failed' ? '未通过' : entry.state === 'cancelled' ? '已取消' : undefined}
            icon={workEntryIcon(entry)}
          />
        )
      })}
    </div>
  )
}

export function ReasoningDisclosureRow({
  text,
  streaming = false,
}: {
  readonly text: string
  readonly streaming?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const headline = extractReasoningHeadline(text)
  const hasMoreBody = text.trim() !== headline
  return (
    <div className="conversation-reasoning-row" data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="conversation-work-summary-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={!hasMoreBody && !streaming}
        onClick={() => { if (hasMoreBody) setOpen(value => !value) }}
      >
        <span className="conversation-work-summary-icon" aria-hidden="true">
          <Brain size={14} />
        </span>
        <span className={clsx('conversation-work-summary-text', streaming && 'conversation-live-label')}>
          {headline}
        </span>
        {hasMoreBody && <ChevronRight className="conversation-work-chevron" size={13} aria-hidden="true" />}
      </button>
      {hasMoreBody && (
        <div id={panelId} className="conversation-work-collapse" data-open={open ? 'true' : 'false'}>
          <div className="conversation-work-collapse-inner">
            {open && (
              <div className="conversation-reasoning-body my-scrollbar">
                {text}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function WorkLogGroup({
  entries,
  open,
  onOpenChange,
  variant = 'standalone',
}: {
  readonly entries: readonly ConversationTimelineWorkEntry[]
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly variant?: 'standalone' | 'nested'
}): JSX.Element {
  const panelId = useId()
  const runningEntry = [...entries].reverse().find((entry) => entry.state === 'running')
  const isRunning = Boolean(runningEntry)
  const runningDetail = runningEntry ? sanitizeWorkDetail(runningEntry) : undefined
  const { summary, category, hasFailure } = summarizeWorkEntries(entries)
  const heading = isRunning
    ? `正在${runningEntry?.text ?? '执行工具'}`
    : summary

  return (
    <div
      className="conversation-work-group"
      data-variant={variant}
      data-running={isRunning ? 'true' : undefined}
      data-failed={hasFailure ? 'true' : undefined}
      data-open={open ? 'true' : undefined}
    >
      <button
        type="button"
        className="conversation-work-summary-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onOpenChange(!open)}
      >
        <span className="conversation-work-summary-icon" aria-hidden="true">
          {isRunning ? (
            <LoaderCircle size={14} className="conversation-work-spinner animate-spin motion-reduce:animate-none" />
          ) : hasFailure ? (
            <CircleAlert size={14} className="conversation-work-failed-icon" />
          ) : (
            categoryIcon(category)
          )}
        </span>
        <span className={isRunning ? 'conversation-live-label' : 'conversation-work-summary-text'}>
          {heading}
        </span>
        {isRunning && runningDetail && (
          <span className={clsx('conversation-work-arg-chip', runningEntry?.mono && 'conversation-work-arg-chip-mono')}>
            {runningDetail}
          </span>
        )}
        {isRunning && entries.length > 1 && (
          <span className="conversation-work-trigger-meta">{entries.length} 步</span>
        )}
        <ChevronRight className="conversation-work-chevron" size={13} aria-hidden="true" />
      </button>
      <div id={panelId} className="conversation-work-collapse" data-open={open ? 'true' : 'false'}>
        <div className="conversation-work-collapse-inner">
          {open && (
            <div className="conversation-work-detail-panel my-scrollbar">
              <WorkTaskList entries={entries} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function WorkLogDisclosure({
  label,
  workEntries = [],
  open,
  onOpenChange,
  children,
}: {
  readonly label: string
  readonly workEntries?: readonly ConversationTimelineWorkEntry[]
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly children: ReactNode
}) {
  const entriesId = useId()
  const fallbackSummary = workEntries.length > 0 ? summarizeWorkEntries(workEntries).summary : '查看执行过程'
  const primaryLabel = label || fallbackSummary
  return (
    <div className="conversation-work-fold" data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="conversation-work-trigger"
        aria-expanded={open}
        aria-controls={entriesId}
        onClick={() => onOpenChange(!open)}
      >
        <span className="conversation-work-trigger-label">{primaryLabel}</span>
        <ChevronRight className="conversation-work-chevron" size={13} aria-hidden="true" />
      </button>
      <div id={entriesId} className="conversation-work-collapse" data-open={open ? 'true' : 'false'}>
        <div className="conversation-work-collapse-inner">
          {open && <div className="conversation-work-trace">{children}</div>}
        </div>
      </div>
    </div>
  )
}
