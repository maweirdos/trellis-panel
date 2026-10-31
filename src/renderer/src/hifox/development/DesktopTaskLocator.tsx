import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { Check, Copy, Loader2 } from 'lucide-react'
import type { HifoxSnapshot, HifoxTask } from '@shared/hifox'
import type { HifoxWorkspaceContext } from '@shared/hifox-remote'
import { api } from '../../api'
import { Button } from '../../my/ui'
import { taskActorId } from '../pages/task-detail/use-task-source'
import { textareaClass } from '../ui'

function teamOrigin(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? '')
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : null
  } catch { return null }
}

/** Manual desktop location uses the displayed original source; it grants no local execution. */
export function DesktopTaskLocator({ snapshot, task, context, available, ownsSource }: {
  snapshot: HifoxSnapshot
  task: HifoxTask
  context: HifoxWorkspaceContext
  available: boolean
  ownsSource(): boolean
}): JSX.Element {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const [expanded, setExpanded] = useState(false)
  const [copyValue, setCopyValue] = useState('')
  const [copyKind, setCopyKind] = useState<'number' | 'context'>('context')
  const mounted = useRef(false), pending = useRef(false), requests = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textArea = useRef<HTMLTextAreaElement>(null)
  const shared = context.state !== 'local'
  const origin = shared ? teamOrigin(context.origin) : null
  const actorId = taskActorId(snapshot, context)
  const actor = snapshot.members.find((member) => member.id === actorId)
  const space = snapshot.spaces.find((item) => item.id === task.spaceId)
  const fields = [
    { label: '来源范围', value: shared ? '团队工作区' : '本机预览（未提供共享团队来源）' },
    { label: '团队 origin', value: shared ? origin ?? '未提供，请核对原团队连接信息' : '未提供（本机范围）' },
    { label: '工作区', value: shared ? `${context.projectName ?? '名称未提供'}${context.projectId ? ` · ${context.projectId}` : ''}` : '本机工作区' },
    { label: '工作区标识', value: context.key },
    { label: '空间', value: `${space?.name ?? '名称未提供'} · ${task.spaceId}` },
    { label: '任务编号', value: task.id },
    { label: '创建时间', value: task.createdAt },
    { label: shared ? '账号身份' : '本机身份', value: `${actor?.name ?? '姓名未提供'}${actor?.email ? ` · ${actor.email}` : ''} · ${actorId ?? '身份未取得'}` }
  ]
  const instructions = shared
    ? `在桌面使用同一账号和工作区，从“收件箱”打开 ${task.id} 的交接提醒，即可继续原任务。首次连接时先核对原团队地址。`
    : '此处没有共享团队来源。请在对应桌面的本机工作区按任务编号核对。'
  const locationText = [...fields.map(({ label, value }) => `${label}：${value}`), '', instructions].join('\n')
  const clearTimer = (): void => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null } }
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; requests.current++; pending.current = false; clearTimer() }
  }, [])
  useEffect(() => {
    if (expanded && status === 'error' && ownsSource()) { textArea.current?.focus(); textArea.current?.select() }
  }, [expanded, status])
  async function copy(kind: 'number' | 'context' = 'context'): Promise<void> {
    if (!mounted.current || !available || !ownsSource() || pending.current) return
    const ticket = ++requests.current
    const current = (): boolean => mounted.current && requests.current === ticket && ownsSource()
    const value = kind === 'number' ? task.id : locationText
    pending.current = true; clearTimer(); setStatus('copying'); setCopyKind(kind); setCopyValue(value)
    try {
      if (api && Object.hasOwn(api, 'copyToClipboard') && typeof api.copyToClipboard === 'function') await api.copyToClipboard(value)
      else if (typeof navigator.clipboard?.writeText === 'function') await navigator.clipboard.writeText(value)
      else throw Error('Clipboard unavailable')
      if (!current()) return
      setStatus('copied')
      timer.current = setTimeout(() => { timer.current = null; if (current()) setStatus('idle') }, 2500)
    } catch {
      if (current()) { setStatus('error'); setExpanded(true) }
    } finally { pending.current = false }
  }
  if (!available) return <p role="status" className="text-my-xs text-my-secondary">原任务来源已变化，请重新打开任务核对。</p>
  return <div className="min-w-0 space-y-3 text-my-xs text-my-secondary" aria-label="桌面任务定位">
    <p className="font-medium text-my-primary">{task.id} · {task.title}</p><p>{instructions}</p>
    <div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" disabled={status === 'copying'} onClick={() => void copy('number')}>{status === 'copied' && copyKind === 'number' ? <Check size={13} /> : <Copy size={13} />}{status === 'copied' && copyKind === 'number' ? '已复制任务编号' : '复制任务编号'}</Button><Button variant="ghost" size="sm" disabled={status === 'copying'} onClick={() => void copy()}>{status === 'copying' && copyKind === 'context' ? <Loader2 size={13} className="animate-spin" /> : status === 'copied' && copyKind === 'context' ? <Check size={13} /> : <Copy size={13} />}{status === 'copied' && copyKind === 'context' ? '已复制完整定位信息' : '复制完整定位信息'}</Button><Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => { if (ownsSource()) setExpanded((value) => !value) }}>{expanded ? '收起定位文本' : '展开定位文本'}</Button></div>
    <details><summary className="cursor-pointer">核对原团队与任务身份</summary><dl className="mt-2 min-w-0 space-y-1">{fields.map(({ label, value }) => <div key={label} className="flex min-w-0 flex-wrap gap-x-2"><dt className="shrink-0 text-my-tertiary">{label}</dt><dd className="min-w-0 break-all text-my-primary">{value}</dd></div>)}</dl></details>
    {status === 'error' && <p role="alert">复制不可用，请选中下方定位文本复制。</p>}
    {expanded && <textarea ref={textArea} readOnly rows={10} aria-label="可选中的任务定位文本" className={`${textareaClass} font-mono text-my-xs`} value={status === 'error' ? copyValue : locationText} />}
  </div>
}
