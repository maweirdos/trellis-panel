import { isConversationRuntimeEvent } from './runtime-events'
import { Check, ChevronRight, Copy, FileText, GitBranch, Loader2, Minimize2, Pencil, Search, ShieldQuestion, Sparkles, Terminal, TriangleAlert, Workflow } from 'lucide-react'
import { clsx } from 'clsx'
import { MarkdownView } from '../components/MarkdownView'
import { Button } from '../my/ui'
import { ActivityResult } from '../my/ActivityResult'
import { asObject, runtimeActivityLabel, type RenderItem } from './timeline'
import { ConnectionNotice } from './ConnectionNotice'
import { RunActivity } from './RunActivity'
import { ThoughtActivity } from './ThoughtActivity'
import { ImageAttachments } from './ImageAttachments'
import { knowledgeObservation, knowledgeObservationLabel } from './conversation-convenience'
import { KnowledgeOperationRow } from './KnowledgeOperationRow'
import { SavedArtifactMessage } from './SavedArtifactMessage'
import { projectRootKey } from '../my/navigation'
import type { AcpPermissionPayload, AcpSessionRecord, TimelineEvent } from '../../../shared/types'
import { useMemo, type JSX } from 'react'
import { useCopyFeedback } from '../utils/use-copy-feedback'

function CopyMessageButton({ text, ownerKey }: { text: string; ownerKey: string }): JSX.Element {
  const owner = useMemo(() => ({ ownerKey, text }), [ownerKey, text])
  const { status, copy } = useCopyFeedback(owner)
  const label = status === 'copying' ? '正在复制' : status === 'copied' ? '已复制' : status === 'error' ? '重试复制' : '复制内容'
  return <div className="acp-message-actions">
    <button type="button" className="acp-message-copy-btn" aria-label={label} aria-disabled={status === 'copying'} title={label} onClick={() => void copy(text)}>
      {status === 'copied' ? <Check size={12} aria-hidden="true" /> : status === 'error' ? <TriangleAlert size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
    </button>
    <span role="status" aria-live="polite" className={clsx('acp-copy-feedback', status === 'error' && 'text-my-danger-text')}>{status === 'error' ? '复制失败，请重试或选择文字复制' : status === 'copied' ? '已复制' : status === 'copying' ? '正在复制…' : ''}</span>
  </div>
}

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

export function EventRow({ item, session, events, pendingPerm, permissionPending, permissionErrors, onRespond, onOpenTask, onOpenArtifact, onOpenSpec, onOpenJira, suppressWorkingIndicator = false }: {
  item: RenderItem
  session?: AcpSessionRecord
  events?: TimelineEvent[]
  suppressWorkingIndicator?: boolean
  pendingPerm: Record<string, AcpPermissionPayload>
  permissionPending: Record<string, boolean>
  permissionErrors: Record<string, string>
  onRespond: (requestId: string, optionId: string) => void
  onOpenTask: (dirName: string) => void
  onOpenArtifact: (file: { name: string; path: string; kind: 'file'; size: number; mtime: number; ext: string }) => void
  onOpenSpec: () => void
  onOpenJira: () => void
}): JSX.Element {
  if (item.type === 'user') {
    const origin = events?.find((event) => event.id === item.key)
    const preparing = Boolean(origin && session && isConversationRuntimeEvent(origin) && origin.sessionId === session.sessionId && projectRootKey(origin.projectRoot) === projectRootKey(session.projectRoot) && origin.turnId === session.turnId && origin.connectionGeneration === session.connectionGeneration && ['busy', 'awaiting_permission', 'cancelling'].includes(session.status))
    return <div data-acp-item={item.key} className="acp-turn-start flex justify-end"><div className="acp-user-message max-w-[88%]">
      {item.images && <ImageAttachments images={item.images} />}
      {item.text && <div className="acp-chat-copy whitespace-pre-wrap break-words rounded-my-lg bg-my-layer-1 px-4 py-3 text-my-primary">{item.text}</div>}
      {item.delivery && item.delivery !== 'sent' && !(item.delivery === 'preparing' && preparing && suppressWorkingIndicator) && <span className={clsx('acp-prompt-delivery', item.delivery === 'not_sent' && 'is-not-sent')} title={item.delivery === 'preparing' ? preparing ? '正在准备项目知识参考，尚未发送给模型。' : '仅找到准备记录，尚未确认是否实际发送给模型。' : undefined}>{item.delivery === 'preparing' ? preparing ? '准备中…' : '发送状态未确认' : '未发送给模型'}</span>}
    </div></div>
  }
  if (item.type === 'agent') return <div data-acp-item={item.key} className={clsx('my-chat-prose acp-answer acp-chat-copy min-w-0 break-words text-my-primary', item.startsAnswer && 'acp-answer-start')}><SavedArtifactMessage text={item.text} messageId={item.key} events={events ?? []} session={session} /><CopyMessageButton text={item.text} ownerKey={JSON.stringify([session?.projectRoot, session?.sessionId, session?.connectionGeneration, item.key])} /></div>
  if (item.type === 'knowledge-operation') return <KnowledgeOperationRow item={item} session={session} onOpenTask={onOpenTask} suppressWorkingIndicator={suppressWorkingIndicator} />
  if (item.type === 'thought') {
    const originIndex = events?.findIndex((event) => event.id === item.key) ?? -1
    const origin = originIndex >= 0 ? events?.[originIndex] : undefined
    const segmentEnded = origin && events?.slice(originIndex + 1).some((event) =>
      event.source === origin.source && projectRootKey(event.projectRoot) === projectRootKey(origin.projectRoot) && event.sessionId === origin.sessionId && event.turnId === origin.turnId && event.connectionGeneration === origin.connectionGeneration && (
        (event.kind === 'message' && Boolean(event.text?.trim())) ||
        event.kind === 'tool-call' || event.kind === 'plan' || event.kind === 'turn-done'
      ))
    return <div data-acp-item={item.key}><ThoughtActivity text={item.text} streaming={Boolean(origin && isConversationRuntimeEvent(origin) && session?.status === 'busy' && origin.sessionId === session.sessionId && projectRootKey(origin.projectRoot) === projectRootKey(session.projectRoot) && origin.turnId === session.turnId && origin.connectionGeneration === session.connectionGeneration && !segmentEnded)} /></div>
  }
  if (item.type === 'activity') return session ? <RunActivity item={item} session={session} /> : <details data-acp-item={item.key} className="acp-activity-row"><summary><Workflow size={14} /><span>处理记录</span><ChevronRight size={13} className="acp-disclosure-arrow" /></summary><div className="acp-activity-body">{item.events.map((event) => <p key={event.id}>{String(asObject(event.payload?.observation)?.label ?? event.text ?? runtimeActivityLabel(event))}</p>)}</div></details>
  if (item.type === 'change-group') return <details data-acp-item={item.key} className="acp-result-disclosure acp-change-group">
    <summary><ActivityResult
      icon={<FileText size={18} />}
      title={`${item.files.length} 个文件变更`}
      description={item.events.length > 1 ? <span className="acp-change-count">{item.events.length} 次更新</span> : undefined}
      action={<span className="acp-result-view"><span className="acp-change-expand">展开记录</span><span className="acp-change-collapse">收起记录</span><ChevronRight size={13} className="acp-disclosure-arrow" /></span>}
    /></summary>
    <div className="acp-result-body acp-change-list">{item.files.map((file) => {
      const latest = file.events[file.events.length - 1]
      const material = asObject(latest.payload?.materialChange)
      const relative = typeof material?.relativePath === 'string' ? material.relativePath : undefined
      const displayPath = [latest.payload?.file, relative].find((value): value is string => typeof value === 'string' && Boolean(value.trim())) ?? file.path
      const readableMaterial = latest.kind === 'material-change' && material?.availability === 'readable' && material.kind !== 'unlink'
      const materialPath = readableMaterial && relative && relative.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..' && !part.includes(':'))
        ? `${latest.projectRoot.replace(/[\\/]+$/, '')}/${relative}` : undefined
      const path = latest.kind === 'doc-created' && typeof latest.payload?.path === 'string' && latest.payload.path.trim() ? latest.payload.path : materialPath
      const name = path?.split(/[\\/]/).at(-1) ?? file.path
      const action = file.events.some((event) => event.kind === 'spec-updated')
        ? <Button size="sm" variant="outline" onClick={onOpenSpec}>查看规范</Button>
        : path ? <Button size="sm" variant="outline" onClick={() => onOpenArtifact({ name, path, kind: 'file', size: 0, mtime: latest.ts, ext: name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '' })}>阅读文件</Button> : undefined
      return <div key={file.path} className="acp-change-row">
        <FileText size={14} aria-hidden="true" /><span className="acp-change-file" title={file.path}>{displayPath}</span>
        {file.events.length > 1 && <span className="acp-change-count">{file.events.length} 次更新</span>}{action}
      </div>
    })}</div>
  </details>
  if (item.type === 'tool') {
    const { title, status, payload } = item.tool
    const kind = String(payload.kind ?? '')
    const diff = Array.isArray(payload.content) ? payload.content.map(asObject).find((entry) => entry?.type === 'diff') : undefined
    const path = (Array.isArray(payload.locations) ? asObject(payload.locations[0])?.path : undefined) ?? diff?.path
    const fileName = typeof path === 'string' ? path.split(/[\\/]/).at(-1) : undefined
    const Icon = kind === 'execute' ? Terminal : kind === 'edit' ? Pencil : kind === 'search' ? Search : FileText
    const pending = !['completed', 'failed', 'cancelled'].includes(status)
    const origin = events?.find((event) => event.id === item.key)
    const sameTurn = (event: TimelineEvent): boolean => Boolean(origin && event.source === origin.source && event.sessionId === origin.sessionId && projectRootKey(event.projectRoot) === projectRootKey(origin.projectRoot) && event.turnId === origin.turnId && event.connectionGeneration === origin.connectionGeneration)
    const running = Boolean(pending && origin?.turnId && origin.connectionGeneration && session && origin.sessionId === session.sessionId && projectRootKey(origin.projectRoot) === projectRootKey(session.projectRoot) && origin.turnId === session.turnId && origin.connectionGeneration === session.connectionGeneration && ['busy', 'awaiting_permission', 'cancelling'].includes(session.status) && !events?.some((event) => event.kind === 'turn-done' && sameTurn(event)))
    const unfinished = pending && !running
    const label = kind === 'execute' ? running ? '正在运行命令' : unfinished ? '命令执行未完成' : '运行了命令' : kind === 'read' ? `${running ? '正在读取文件' : unfinished ? '文件读取未完成' : '读取了文件'}${fileName ? ` ${fileName}` : ''}` : kind === 'search' ? running ? '正在搜索项目' : unfinished ? '项目搜索未完成' : '搜索了项目' : title
    const editing = kind === 'edit'
    return <details data-acp-item={item.key} className={clsx(editing ? 'acp-result-disclosure' : 'acp-activity-row', status === 'failed' && 'is-failed')}>
      <summary title={title}>
        {editing ? <ActivityResult
          icon={running && !suppressWorkingIndicator ? <Loader2 size={18} className="animate-spin" /> : <Pencil size={18} />}
          title={`${running ? '正在编辑' : unfinished ? '编辑未完成' : status === 'failed' ? '编辑失败' : status === 'cancelled' ? '编辑已取消' : '已编辑'} ${fileName ?? title}`}
          description={typeof path === 'string' ? path : undefined}
          tone={status === 'failed' ? 'danger' : 'default'}
          action={<span className="acp-result-view">{diff ? '查看变更' : '查看记录'}<ChevronRight size={13} className="acp-disclosure-arrow" /></span>}
        /> : <>
          {running && !suppressWorkingIndicator ? <Loader2 size={14} className="shrink-0 animate-spin" /> : <Icon size={14} />}
          <span className="truncate">{label}{status === 'failed' ? ' · 失败' : status === 'cancelled' ? ' · 已取消' : ''}</span><ChevronRight size={13} className="acp-disclosure-arrow" />
        </>}
      </summary>
      <div className={clsx(editing ? 'acp-result-body' : 'acp-activity-body', 'space-y-2')}>
        <p className="break-words font-mono text-my-sm text-my-secondary">{title}</p>
        {typeof payload.preview === 'string' && <p className="whitespace-pre-wrap break-words text-my-secondary">{payload.preview}</p>}
        <ToolContent value={payload.content} />
        {typeof payload.outputText === 'string' && payload.outputText && <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-my-sm">{payload.outputText}</pre>}
        {payload.outputDeltaTruncated === true && <p className="text-my-sm text-my-tertiary">工具输出超出显示限额，当前仅显示部分内容。</p>}
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
    if (item.ev.payload?.tag === 'pi_compaction') {
      const state = item.ev.payload.status ?? item.ev.payload.phase
      const failed = state === 'failed' || state === 'error' || Boolean(item.ev.payload.error)
      return <div data-acp-item={item.key}>{failed ? <ConnectionNotice message={runtimeActivityLabel(item.ev)} /> : <div className="my-activity-note" role="status" title={item.ev.text}><Minimize2 size={14} aria-hidden="true" /><span>{runtimeActivityLabel(item.ev)}</span></div>}</div>
    }
    const knowledge = knowledgeObservation(item.ev)
    if (knowledge) return <details className="rounded-my-md border border-my-line px-3 py-2 text-my-xs text-my-secondary"><summary className="cursor-pointer">{knowledgeObservationLabel(knowledge)}</summary><p className="mt-2 whitespace-pre-wrap break-words text-my-tertiary">{knowledge.detail || item.ev.text}</p><RawData value={item.ev.payload} /></details>
    if (item.ev.kind === 'diagnostic' || item.ev.payload?.type === 'error' || item.ev.payload?.error || item.ev.payload?.status === 'failed' || item.ev.payload?.status === 'error' || asObject(item.ev.payload?.observation)?.status === 'failed') return <ConnectionNotice message={item.ev.text || String(asObject(item.ev.payload?.observation)?.label ?? '执行引擎返回错误')} />
    return <details className="rounded-my-md px-2 py-1 text-my-sm text-my-tertiary"><summary className="cursor-pointer break-words">{item.ev.text ?? item.ev.kind}</summary><p className="mt-2 whitespace-pre-wrap break-words">{item.ev.text ?? '执行引擎记录了此项状态更新。'}</p></details>
  }
  if (item.type !== 'trellis') return <></>
  const ev = item.ev
  const taskDir = ev.taskDir ?? (typeof ev.payload?.taskDir === 'string' ? ev.payload.taskDir : undefined)
  const filePath = typeof ev.payload?.path === 'string' ? ev.payload.path : undefined
  const action = ev.kind === 'task-status' && taskDir ? <Button size="sm" variant="outline" onClick={() => onOpenTask(taskDir)}>查看任务</Button>
    : ev.kind === 'doc-created' && filePath ? <Button size="sm" variant="outline" onClick={() => onOpenArtifact({ name: String(ev.payload?.file ?? 'artifact.md'), path: filePath, kind: 'file', size: 0, mtime: ev.ts, ext: (String(ev.payload?.file ?? '.md').split('.').pop() ?? 'md').toLowerCase() })}>阅读文件</Button>
    : ev.kind === 'spec-injected' || ev.kind === 'spec-updated' ? <Button size="sm" variant="outline" onClick={onOpenSpec}>查看规范</Button>
    : ev.kind === 'jira-sync' ? <Button size="sm" variant="outline" onClick={onOpenJira}>查看 Jira</Button> : undefined
  return <ActivityResult icon={TRELLIS_ICON[ev.kind] ?? <Sparkles size={16} />} title={ev.text ?? ev.kind} description={taskDir ? `任务：${taskDir}` : '项目活动'} action={action} />
}
