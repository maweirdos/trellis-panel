import { useEffect, useState, type JSX } from 'react'
import { Check, ChevronDown, ChevronUp, Copy, Download, ListChecks, Play, TriangleAlert } from 'lucide-react'
import { Button } from '../my/ui'
import { useCopyFeedback } from '../utils/use-copy-feedback'
import { ChatMarkdown } from './ChatMarkdown'
import './conversation-enhancements.css'

const COLLAPSE_LINE_THRESHOLD = 14

export interface ProposedPlanCardProps {
  readonly id: string
  readonly markdown: string
  readonly forceExpanded?: boolean
  readonly implementing?: boolean
  readonly onImplementPlan?: (markdown: string) => void
}

function downloadMarkdown(id: string, markdown: string): void {
  try {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `plan-${id.replace(/[^\w-]/g, '').slice(0, 12) || 'proposal'}.md`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch {
    // 浏览器环境不支持 Blob 下载时静默降级
  }
}

export function ProposedPlanCard({
  id,
  markdown,
  forceExpanded = false,
  implementing = false,
  onImplementPlan,
}: ProposedPlanCardProps): JSX.Element {
  const lineCount = markdown.split(/\r?\n/).length
  const collapsible = lineCount > COLLAPSE_LINE_THRESHOLD
  const [expanded, setExpanded] = useState(!collapsible)
  const copy = useCopyFeedback(id)

  useEffect(() => {
    if (forceExpanded) setExpanded(true)
  }, [forceExpanded])

  const isCollapsed = collapsible && !expanded

  return (
    <section className="conversation-plan-card" aria-label="实施方案建议">
      <header className="conversation-plan-card-header">
        <span className="conversation-plan-card-title">
          <ListChecks size={14} aria-hidden="true" />
          <span className="truncate">实施方案建议</span>
        </span>
        <div className="conversation-plan-card-actions">
          <button
            type="button"
            className="my-icon-control"
            title="复制方案内容"
            aria-label={copy.status === 'copied' ? '已复制方案内容' : '复制方案内容'}
            onClick={() => { if (copy.status !== 'copying') void copy.copy(markdown) }}
          >
            {copy.status === 'copied' ? <Check size={13} aria-hidden="true" />
              : copy.status === 'error' ? <TriangleAlert size={13} aria-hidden="true" />
                : <Copy size={13} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="my-icon-control"
            title="下载 Markdown 文件"
            aria-label="下载方案 Markdown 文件"
            onClick={() => downloadMarkdown(id, markdown)}
          >
            <Download size={13} aria-hidden="true" />
          </button>
          {collapsible && (
            <button
              type="button"
              className="my-icon-control"
              title={expanded ? '收起方案' : '展开完整方案'}
              aria-label={expanded ? '收起方案' : '展开完整方案'}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
            </button>
          )}
        </div>
      </header>
      <div className="conversation-plan-card-body" data-collapsed={isCollapsed ? 'true' : undefined}>
        <div className="conversation-message-body">
          <ChatMarkdown text={markdown} />
        </div>
      </div>
      {(collapsible || onImplementPlan) && (
        <footer className="conversation-plan-card-footer">
          {collapsible ? (
            <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起方案' : `展开完整方案（共 ${lineCount} 行）`}
            </Button>
          ) : <span />}
          {onImplementPlan && (
            <Button
              size="sm"
              variant="primary"
              disabled={implementing}
              onClick={() => onImplementPlan(markdown)}
            >
              <Play size={13} aria-hidden="true" />
              {implementing ? '正在启动实施…' : '按此方案执行'}
            </Button>
          )}
        </footer>
      )}
    </section>
  )
}
