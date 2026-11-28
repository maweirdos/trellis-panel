import { useState, type JSX, type ReactNode } from 'react'
import { ChevronRight, Code2, Loader2, RotateCcw } from 'lucide-react'
import type { TeamCodeResource } from '@shared/team-code-resources'
import { Button, DisclosureGrid } from '../../my/ui'
import type { ResourceCommands } from './resource-state'

function ResourceDisclosure({
  summary,
  children,
  defaultOpen = false,
  className = 'text-my-xs text-my-tertiary',
  summaryClassName = 'flex cursor-pointer items-center gap-1 text-left hover:text-my-primary'
}: {
  summary: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
  summaryClassName?: string
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={className}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={summaryClassName}>
        <ChevronRight size={12} className="my-disclosure-chevron shrink-0" data-open={open || undefined} />
        {summary}
      </button>
      <DisclosureGrid open={open} innerClassName="pt-2">
        {children}
      </DisclosureGrid>
    </div>
  )
}

export function ResourceSummary({ resource }: { resource: TeamCodeResource }): JSX.Element {
  return <div className="min-w-0 space-y-1">
    <div className="flex flex-wrap items-center gap-2"><Code2 size={15} className="shrink-0 text-my-icon-secondary" /><span className="my-item-title min-w-0 break-words">{resource.name}</span>{resource.disabled && <span className="my-chip text-my-warning-text">已停用</span>}</div>
    <p className="my-item-description break-words">{resource.purpose}</p>
    <ResourceDisclosure summary="仓库来源与模块">
      <dl className="space-y-2"><div><dt>仓库</dt><dd className="break-all text-my-secondary">{resource.source.provider} · {resource.source.repositoryId}<br />{resource.source.repositoryUrl}</dd></div><div><dt>完整基座 / 模块</dt><dd className="break-words text-my-secondary">{resource.moduleDescription}</dd></div></dl>
    </ResourceDisclosure>
  </div>
}

export function ResourceRecovery({ commands }: { commands: ResourceCommands }): JSX.Element {
  const labels = { create: '创建代码资源', update: '编辑代码资源', setSpaceResources: '关联空间资源', selectTaskResource: '选择任务资源' }
  return <div className="min-w-0 space-y-2">
    {commands.error && <div role="alert" className="rounded-my-base border border-my-line p-3 text-my-xs text-my-danger-text"><p className="break-words">{commands.error}</p></div>}
    {commands.message && <p role="status" className="text-my-xs text-my-secondary">{commands.message}</p>}
    {commands.pending.length > 0 && <ResourceDisclosure
      defaultOpen
      className="rounded-my-base border border-my-line p-3 text-my-xs"
      summaryClassName="flex cursor-pointer items-center gap-1.5 text-left text-my-secondary hover:text-my-primary"
      summary={`待核对资源操作 · ${commands.pending.length}`}
    >
      <ul className="divide-y divide-my-line">{commands.pending.map((entry) => <li key={entry.commandId} className="space-y-2 py-2">
        <p className="text-my-secondary">{labels[entry.kind]} · {entry.state === 'unknown' ? '结果未知' : entry.state === 'rejected' ? '未完成' : '待核对'}</p>
        {entry.error && <p className="break-words text-my-danger-text">{entry.error}</p>}
        <ResourceDisclosure summary="操作标识"><code className="break-all">{entry.commandId}</code></ResourceDisclosure>
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={commands.busy} onClick={() => commands.recover(entry.commandId, false)}>核对结果</Button><Button size="sm" variant="ghost" disabled={commands.busy} onClick={() => commands.recover(entry.commandId, true)}>以原内容重试</Button></div>
      </li>)}</ul>
    </ResourceDisclosure>}
    {commands.intent?.state === 'rejected' && <Button size="sm" variant="ghost" disabled={commands.busy} onClick={commands.editAgain}>修改草稿，保留原操作记录</Button>}
  </div>
}

export function ResourceLoadState({ loading, error, refresh }: { loading: boolean; error: string; refresh(): void }): JSX.Element {
  return <div className="flex flex-wrap items-center gap-2 text-my-xs">
    {loading && <span role="status" className="flex items-center gap-2 text-my-tertiary"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" />正在核对资源…</span>}
    {error && <p role="alert" className="min-w-0 break-words text-my-danger-text">{error}</p>}
    <Button size="sm" variant="ghost" disabled={loading} onClick={refresh}><RotateCcw size={13} />重新核对</Button>
  </div>
}
