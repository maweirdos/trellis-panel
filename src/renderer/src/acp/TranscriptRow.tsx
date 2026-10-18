import { ChevronRight, FileText, GitBranch, Loader2, Pencil, Search, ShieldQuestion, Sparkles, Terminal, Workflow } from 'lucide-react'
import { clsx } from 'clsx'
import { MarkdownView } from '../components/MarkdownView'
import { Button } from '../my/ui'
import { asObject, type RenderItem } from './timeline'
import { ConnectionNotice } from './ConnectionNotice'
import { RunActivity } from './RunActivity'
import { ThoughtActivity } from './ThoughtActivity'
import { ImageAttachments } from './ImageAttachments'
import type { AcpPermissionPayload, AcpSessionRecord, TimelineEvent } from '../../../shared/types'
import type { JSX } from 'react'

const TRELLIS_ICON: Record<string, JSX.Element> = {
  'task-status': <Workflow size={13} />, 'doc-created': <FileText size={13} />,
  'spec-injected': <Sparkles size={13} />, 'spec-updated': <Sparkles size={13} />, 'jira-sync': <GitBranch size={13} />
}

function RawData({ value }: { value: unknown }): JSX.Element {
  return <pre className="my-scrollbar max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-my-md bg-my-surface-1 p-2 font-mono text-my-sm text-my-secondary">{JSON.stringify(value, null, 2)}</pre>
}

function ToolContent({ value }: { value: unknown }): JSX.Element | null {
  if (!Array.isArray(value)) return null
  return <div className="space-y-2">{value.map((entry, index) => {
    const block = asObject(entry)
    if (!block) return <RawData key={index} value={entry} />
    const content = asObject(block.content)
    if (block.type === 'content' && content?.type === 'text' && typeof content.text === 'string') return <div key={index} className="break-words"><MarkdownView content={content.text} /></div>
    if (block.type === 'diff') return <div key={index} className="space-y-1 text-my-sm">
      <div className="break-all font-mono text-my-secondary">{String(block.path ?? '')}</div>
      {typeof block.oldText === 'string' && <pre className="my-scrollbar max-h-60 overflow-auto whitespace-pre-wrap rounded-my-sm bg-my-danger-subtle p-2 text-my-danger-text">{block.oldText}</pre>}
      {typeof block.newText === 'string' && <pre className="my-scrollbar max-h-60 overflow-auto whitespace-pre-wrap rounded-my-sm bg-my-success-subtle p-2 text-my-success-text">{block.newText}</pre>}
    </div>
    return <RawData key={index} value={entry} />
  })}</div>
}

export function EventRow({ item, session, events, pendingPerm, permissionPending, permissionErrors, onRespond, onOpenTask, onOpenArtifact, onOpenSpec, onOpenJira }: {
  item: RenderItem
  session?: AcpSessionRecord
  events?: TimelineEvent[]
  pendingPerm: Record<string, AcpPermissionPayload>
  permissionPending: Record<string, boolean>
  permissionErrors: Record<string, string>
  onRespond: (requestId: string, optionId: string) => void
  onOpenTask: (dirName: string) => void
  onOpenArtifact: (file: { name: string; path: string; kind: 'file'; size: number; mtime: number; ext: string }) => void
  onOpenSpec: () => void
  onOpenJira: () => void
}): JSX.Element {
  if (item.type === 'user') return <div className="flex justify-end"><div className="acp-user-message max-w-[88%]">
    {item.images && <ImageAttachments images={item.images} />}
    {item.text && <div className="acp-chat-copy whitespace-pre-wrap break-words rounded-my-lg bg-my-layer-1 px-4 py-3 text-my-primary">{item.text}</div>}
  </div></div>
  if (item.type === 'agent') return <div className={clsx('my-chat-prose acp-chat-copy min-w-0 break-words py-2 text-my-primary', item.startsAnswer && 'acp-answer-start')}><MarkdownView content={item.text} /></div>
  if (item.type === 'thought') {
    const originIndex = events?.findIndex((event) => event.id === item.key) ?? -1
    const origin = originIndex >= 0 ? events?.[originIndex] : undefined
    const segmentEnded = origin && events?.slice(originIndex + 1).some((event) =>
      event.sessionId === origin.sessionId && event.turnId === origin.turnId && event.connectionGeneration === origin.connectionGeneration && (
        (event.kind === 'message' && Boolean(event.text?.trim())) ||
        event.kind === 'tool-call' || event.kind === 'plan' || event.kind === 'turn-done'
      ))
    return <ThoughtActivity text={item.text} streaming={Boolean(origin && session?.status === 'busy' && origin.turnId === session.turnId && origin.connectionGeneration === session.connectionGeneration && !segmentEnded)} />
  }
  if (item.type === 'activity') return session ? <RunActivity item={item} session={session} events={events ?? item.events} renderDetail={(child) => <EventRow key={child.key} item={child} session={session} events={events} pendingPerm={pendingPerm} permissionPending={permissionPending} permissionErrors={permissionErrors} onRespond={onRespond} onOpenTask={onOpenTask} onOpenArtifact={onOpenArtifact} onOpenSpec={onOpenSpec} onOpenJira={onOpenJira} />} /> : <details className="acp-activity-row"><summary><Workflow size={14} /><span>处理记录</span><ChevronRight size={13} className="acp-disclosure-arrow" /></summary><details className="acp-run-diagnostics"><summary>查看诊断记录</summary><RawData value={item.events} /></details></details>
  if (item.type === 'tool') {
    const { title, status, payload } = item.tool
    const kind = String(payload.kind ?? '')
    const path = Array.isArray(payload.locations) ? asObject(payload.locations[0])?.path : undefined
    const fileName = typeof path === 'string' ? path.split(/[\\/]/).at(-1) : undefined
    const label = kind === 'execute' ? '运行了命令' : kind === 'edit' ? `编辑了文件${fileName ? ` ${fileName}` : ''}` : kind === 'read' ? `读取了文件${fileName ? ` ${fileName}` : ''}` : kind === 'search' ? '搜索了项目' : title
    const Icon = kind === 'execute' ? Terminal : kind === 'edit' ? Pencil : kind === 'search' ? Search : FileText
    const running = status !== 'completed' && status !== 'failed'
    return <details className={clsx('acp-activity-row', status === 'failed' && 'is-failed')}>
      <summary title={title}>
        {running ? <Loader2 size={14} className="shrink-0 animate-spin" /> : <Icon size={14} />}
        <span className="truncate">{label}{status === 'failed' ? ' · 失败' : ''}</span><ChevronRight size={13} className="acp-disclosure-arrow" />
      </summary>
      <div className="acp-activity-body space-y-2">
        <p className="break-words font-mono text-my-sm text-my-secondary">{title}</p>
        {typeof payload.preview === 'string' && <p className="whitespace-pre-wrap break-words text-my-secondary">{payload.preview}</p>}
        <ToolContent value={payload.content} />
        {Array.isArray(payload.locations) && payload.locations.length > 0 && <div className="text-my-sm text-my-secondary">{payload.locations.map((location, index) => {
          const loc = asObject(location)
          return <div key={index} className="break-all font-mono">{String(loc?.path ?? '')}{typeof loc?.line === 'number' ? `:${loc.line}` : ''}</div>
        })}</div>}
        <details><summary className="cursor-pointer text-my-sm text-my-tertiary">原始工具数据</summary><RawData value={payload} /></details>
      </div>
    </details>
  }
  if (item.type === 'perm') {
    const requestId = String(item.ev.payload?.requestId ?? '')
    const pending = pendingPerm[requestId]
    return <div className="rounded-my-md border border-my-line-warning bg-my-warning-subtle px-3 py-2 text-my-sm">
      <div className="flex items-center gap-1.5 font-medium text-my-warning-text"><ShieldQuestion size={13} />{pending?.toolCall?.title ?? item.ev.text ?? '权限请求'}</div>
      {pending ? <>
        <div className="mt-2 flex min-w-0 max-w-full flex-wrap gap-2">{pending.options.map((option) => <Button key={option.optionId} size="sm" variant="outline" disabled={permissionPending[requestId]} className={clsx('!h-auto min-h-6 min-w-0 max-w-full !items-start !justify-start !whitespace-normal !py-2 text-left', option.kind.startsWith('reject') ? 'text-my-danger-text' : 'text-my-accent-text')} title={`原始选项：${option.optionId} · ${option.kind}`} onClick={() => onRespond(requestId, option.optionId)}>{permissionPending[requestId] && <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin" />}<span className="min-w-0 flex-1 whitespace-normal break-words leading-relaxed [overflow-wrap:anywhere]">{option.name}</span></Button>)}</div>
        <p className="mt-2 text-my-sm text-my-secondary">{pending.expiresAt ? `等待选择，${new Date(pending.expiresAt).toLocaleTimeString()} 到期` : '等待选择；超时将取消本轮请求。'} · 选择按 Runtime 原始选项提交</p>
        {permissionErrors[requestId] && <p role="alert" className="mt-1 text-my-sm text-my-danger-text">{permissionErrors[requestId]}</p>}
      </> : <p className="mt-1 text-my-sm text-my-secondary">{item.ev.text ?? '授权记录'} · 历史记录，当前不可操作</p>}
    </div>
  }
  if (item.type === 'turn') return /^(回合已结束|本轮结束|回合已取消)$/.test(item.text) ? <></> : <ConnectionNotice message={item.text} />
  if (item.type === 'detail') {
    if (item.ev.kind === 'diagnostic' || item.ev.payload?.type === 'error' || item.ev.payload?.error || item.ev.payload?.status === 'failed' || item.ev.payload?.status === 'error') return <div>
      <ConnectionNotice message={item.ev.text ?? '执行引擎返回错误'} /><details className="text-my-sm text-my-tertiary"><summary className="cursor-pointer">诊断数据</summary><RawData value={item.ev} /></details>
    </div>
    return <details className="rounded-my-md px-2 py-1 text-my-sm text-my-tertiary"><summary className="cursor-pointer break-words">{item.ev.text ?? item.ev.kind}</summary><RawData value={item.ev} /></details>
  }
  if (item.type !== 'trellis') return <></>
  const ev = item.ev
  const taskDir = ev.taskDir ?? (typeof ev.payload?.taskDir === 'string' ? ev.payload.taskDir : undefined)
  const filePath = typeof ev.payload?.path === 'string' ? ev.payload.path : undefined
  return <div className="my-activity-note">
    {TRELLIS_ICON[ev.kind] ?? <Sparkles size={13} />}<span className="min-w-0 break-words">{ev.text}</span>
    <span>{taskDir ? `任务：${taskDir}` : '项目活动'}</span>
    {ev.kind === 'task-status' && taskDir && <button className="underline underline-offset-2" onClick={() => onOpenTask(taskDir)}>查看任务</button>}
    {ev.kind === 'doc-created' && filePath && <button className="underline underline-offset-2" onClick={() => onOpenArtifact({ name: String(ev.payload?.file ?? 'artifact.md'), path: filePath, kind: 'file', size: 0, mtime: ev.ts, ext: (String(ev.payload?.file ?? '.md').split('.').pop() ?? 'md').toLowerCase() })}>阅读</button>}
    {(ev.kind === 'spec-injected' || ev.kind === 'spec-updated') && <button className="underline underline-offset-2" onClick={onOpenSpec}>规范页</button>}
    {ev.kind === 'jira-sync' && <button className="underline underline-offset-2" onClick={onOpenJira}>Jira</button>}
  </div>
}
