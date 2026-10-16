import { FileText, GitBranch, Loader2, ShieldQuestion, Sparkles, Workflow } from 'lucide-react'
import { clsx } from 'clsx'
import { MarkdownView } from '../components/MarkdownView'
import { Button } from '../my/ui'
import { asObject, runtimeActivityLabel, type RenderItem } from './timeline'
import type { AcpPermissionPayload } from '../../../shared/types'
import type { JSX } from 'react'

const TRELLIS_ICON: Record<string, JSX.Element> = {
  'task-status': <Workflow size={13} />, 'doc-created': <FileText size={13} />,
  'spec-injected': <Sparkles size={13} />, 'spec-updated': <Sparkles size={13} />, 'jira-sync': <GitBranch size={13} />
}

function RawData({ value }: { value: unknown }): JSX.Element {
  return <pre className="my-scrollbar max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-my-md bg-my-surface-1 p-2 font-mono text-my-2xs text-my-secondary">{JSON.stringify(value, null, 2)}</pre>
}

function ToolContent({ value }: { value: unknown }): JSX.Element | null {
  if (!Array.isArray(value)) return null
  return <div className="space-y-2">{value.map((entry, index) => {
    const block = asObject(entry)
    if (!block) return <RawData key={index} value={entry} />
    const content = asObject(block.content)
    if (block.type === 'content' && content?.type === 'text' && typeof content.text === 'string') return <div key={index} className="break-words"><MarkdownView content={content.text} /></div>
    if (block.type === 'diff') return <div key={index} className="space-y-1 text-my-2xs">
      <div className="break-all font-mono text-my-secondary">{String(block.path ?? '')}</div>
      {typeof block.oldText === 'string' && <pre className="my-scrollbar max-h-60 overflow-auto whitespace-pre-wrap rounded-my-sm bg-my-danger-subtle p-2 text-my-danger-text">{block.oldText}</pre>}
      {typeof block.newText === 'string' && <pre className="my-scrollbar max-h-60 overflow-auto whitespace-pre-wrap rounded-my-sm bg-my-success-subtle p-2 text-my-success-text">{block.newText}</pre>}
    </div>
    return <RawData key={index} value={entry} />
  })}</div>
}

export function EventRow({ item, pendingPerm, permissionPending, permissionErrors, onRespond, onOpenTask, onOpenArtifact, onOpenSpec, onOpenJira }: {
  item: RenderItem
  pendingPerm: Record<string, AcpPermissionPayload>
  permissionPending: Record<string, boolean>
  permissionErrors: Record<string, string>
  onRespond: (requestId: string, optionId: string) => void
  onOpenTask: (dirName: string) => void
  onOpenArtifact: (file: { name: string; path: string; kind: 'file'; size: number; mtime: number; ext: string }) => void
  onOpenSpec: () => void
  onOpenJira: () => void
}): JSX.Element {
  if (item.type === 'user') return <div className="flex justify-end"><div className="max-w-[85%] whitespace-pre-wrap break-words rounded-my-lg bg-my-layer-1-selected px-3 py-2 text-my-sm text-my-primary">{item.text}</div></div>
  if (item.type === 'agent') return <div className="min-w-0 break-words px-1 py-2 text-my-sm text-my-primary"><MarkdownView content={item.text} /></div>
  if (item.type === 'thought') return <details className="rounded-my-md border border-my-line px-3 py-2 text-my-xs text-my-secondary"><summary className="cursor-pointer select-none">Agent 思考摘要</summary><div className="mt-2 break-words"><MarkdownView content={item.text} /></div></details>
  if (item.type === 'activity') return <details className="rounded-my-md border border-my-line px-3 py-2 text-my-2xs text-my-tertiary">
    <summary className="cursor-pointer select-none">运行活动 · {item.events.length} 条</summary>
    <div className="mt-2 space-y-2">{item.events.map((event) => <details key={event.id}>
      <summary className="cursor-pointer text-my-secondary">{runtimeActivityLabel(event)}</summary>
      <p className="my-1 break-words">{event.text}</p><RawData value={event} />
    </details>)}</div>
  </details>
  if (item.type === 'tool') {
    const { title, status, payload } = item.tool
    return <details className="rounded-my-md border border-my-line bg-my-layer-2 text-my-xs">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-my-secondary">
        {status === 'completed' ? <span className="text-my-success-text">✓</span> : status === 'failed' ? <span className="text-my-danger-text">✗</span> : <Loader2 size={12} className="shrink-0 animate-spin" />}
        <span className="min-w-0 flex-1 truncate">{title}</span><span className="text-my-2xs text-my-tertiary">{status} · 展开详情</span>
      </summary>
      <div className="space-y-2 border-t border-my-line p-3">
        {typeof payload.preview === 'string' && <p className="whitespace-pre-wrap break-words text-my-secondary">{payload.preview}</p>}
        <ToolContent value={payload.content} />
        {Array.isArray(payload.locations) && payload.locations.length > 0 && <div className="text-my-2xs text-my-secondary">{payload.locations.map((location, index) => {
          const loc = asObject(location)
          return <div key={index} className="break-all font-mono">{String(loc?.path ?? '')}{typeof loc?.line === 'number' ? `:${loc.line}` : ''}</div>
        })}</div>}
        <details><summary className="cursor-pointer text-my-2xs text-my-tertiary">原始工具数据</summary><RawData value={payload} /></details>
      </div>
    </details>
  }
  if (item.type === 'perm') {
    const requestId = String(item.ev.payload?.requestId ?? '')
    const pending = pendingPerm[requestId]
    return <div className="rounded-my-md border border-my-line-warning bg-my-warning-subtle px-3 py-2 text-my-xs">
      <div className="flex items-center gap-1.5 font-medium text-my-warning-text"><ShieldQuestion size={13} />{pending?.toolCall?.title ?? item.ev.text ?? '权限请求'}</div>
      {pending ? <>
        <div className="mt-2 flex min-w-0 max-w-full flex-wrap gap-2">{pending.options.map((option) => <Button key={option.optionId} size="sm" variant="outline" disabled={permissionPending[requestId]} className={clsx('!h-auto min-h-6 min-w-0 max-w-full !items-start !justify-start !whitespace-normal !py-2 text-left', option.kind.startsWith('reject') ? 'text-my-danger-text' : 'text-my-accent-text')} title={`原始选项：${option.optionId} · ${option.kind}`} onClick={() => onRespond(requestId, option.optionId)}>{permissionPending[requestId] && <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin" />}<span className="min-w-0 flex-1 whitespace-normal break-words leading-relaxed [overflow-wrap:anywhere]">{option.name}</span></Button>)}</div>
        <p className="mt-2 text-my-2xs text-my-secondary">{pending.expiresAt ? `等待选择，${new Date(pending.expiresAt).toLocaleTimeString()} 到期` : '等待选择；超时将取消本轮请求。'} · 选择按 Runtime 原始选项提交</p>
        {permissionErrors[requestId] && <p role="alert" className="mt-1 text-my-xs text-my-danger-text">{permissionErrors[requestId]}</p>}
      </> : <p className="mt-1 text-my-2xs text-my-secondary">{item.ev.text ?? '授权记录'} · 历史记录，当前不可操作</p>}
    </div>
  }
  if (item.type === 'turn') return <div className="flex items-center gap-2 py-2 text-my-2xs text-my-tertiary"><span className="h-px flex-1 bg-my-line" />{item.text}<span className="h-px flex-1 bg-my-line" /></div>
  if (item.type === 'detail') {
    if (item.ev.kind === 'diagnostic' || item.ev.payload?.type === 'error' || item.ev.payload?.error || item.ev.payload?.status === 'failed' || item.ev.payload?.status === 'error') return <div role="alert" className="rounded-my-md border border-my-line-danger bg-my-danger-subtle px-3 py-2 text-my-xs text-my-danger-text">
      <p className="break-words">{item.ev.text ?? 'Runtime 诊断'}</p><details className="mt-1 text-my-2xs"><summary className="cursor-pointer">查看诊断数据</summary><RawData value={item.ev} /></details>
    </div>
    return <details className="rounded-my-md px-2 py-1 text-my-2xs text-my-tertiary"><summary className="cursor-pointer break-words">{item.ev.text ?? item.ev.kind}</summary><RawData value={item.ev} /></details>
  }
  if (item.type !== 'trellis') return <></>
  const ev = item.ev
  const taskDir = ev.taskDir ?? (typeof ev.payload?.taskDir === 'string' ? ev.payload.taskDir : undefined)
  const filePath = typeof ev.payload?.path === 'string' ? ev.payload.path : undefined
  return <div className="flex flex-wrap items-center gap-2 rounded-my-md border border-my-line-info bg-my-info-subtle px-3 py-2 text-my-xs text-my-info-text">
    {TRELLIS_ICON[ev.kind] ?? <Sparkles size={13} />}<span className="min-w-0 break-words">{ev.text}</span>
    <span className="text-my-2xs">{taskDir ? `任务：${taskDir}` : '项目活动'}</span>
    {ev.kind === 'task-status' && taskDir && <button className="underline underline-offset-2" onClick={() => onOpenTask(taskDir)}>查看任务</button>}
    {ev.kind === 'doc-created' && filePath && <button className="underline underline-offset-2" onClick={() => onOpenArtifact({ name: String(ev.payload?.file ?? 'artifact.md'), path: filePath, kind: 'file', size: 0, mtime: ev.ts, ext: (String(ev.payload?.file ?? '.md').split('.').pop() ?? 'md').toLowerCase() })}>阅读</button>}
    {(ev.kind === 'spec-injected' || ev.kind === 'spec-updated') && <button className="underline underline-offset-2" onClick={onOpenSpec}>规范页</button>}
    {ev.kind === 'jira-sync' && <button className="underline underline-offset-2" onClick={onOpenJira}>Jira</button>}
  </div>
}
