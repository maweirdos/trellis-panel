import { useRef, useState, type JSX } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '../api'
import { formatDuration } from './timeline'
import type { AcpConfigureInput, AcpSessionRecord } from '../../../shared/types'

export function StartupGroup({ session }: { session: AcpSessionRecord }): JSX.Element {
  const observations = session.startup ?? []
  return <details className="rounded-my-md border border-my-line p-3 text-my-xs text-my-secondary" open={session.status === 'starting' || observations.some((item) => item.status === 'failed')}>
    <summary className="cursor-pointer">环境准备 · {observations.length ? `${observations.length} 条实际观测` : '暂无观测记录'}</summary>
    <div className="mt-2 space-y-2">{observations.map((item, index) => <div key={`${item.label}:${index}`} className="flex items-start gap-2">
      <span className={item.status === 'failed' ? 'text-my-danger-text' : 'text-my-success-text'}>{item.status === 'failed' ? '✗' : '✓'}</span>
      <span className="min-w-0 flex-1 break-words">{item.label}</span><span className="shrink-0 text-my-2xs text-my-tertiary">{item.durationMs === undefined ? new Date(item.atMs).toLocaleTimeString() : formatDuration(item.durationMs)}</span>
    </div>)}</div>
    <p className="mt-2 text-my-2xs text-my-tertiary">仅显示 Runtime 已提供的观测；未单独报告的握手与登录耗时未知。</p>
  </details>
}

export function SessionDetails({ session, isCurrent, onUpdated }: {
  session: AcpSessionRecord
  isCurrent: () => boolean
  onUpdated: (session: AcpSessionRecord) => void
}): JSX.Element {
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const lock = useRef(false)
  const configure = async (input: AcpConfigureInput): Promise<void> => {
    if (lock.current || !isCurrent() || session.status !== 'ready') return
    lock.current = true
    setPending(input.id)
    setError('')
    setNotice('')
    try {
      const res = await api.acpSessionConfigure(session.sessionId, input)
      if (!isCurrent()) return
      if (res.ok && res.session) { onUpdated(res.session); setNotice('Runtime 已确认配置生效。') }
      else setError(res.error ?? 'Runtime 尚未确认配置，保留原生效值。')
    } catch (err) { if (isCurrent()) setError(err instanceof Error ? err.message : '配置失败，保留原生效值。') }
    finally { lock.current = false; if (isCurrent()) setPending('') }
  }
  const controls = session.capabilities?.controls ?? []
  const disabled = session.status !== 'ready' || Boolean(pending)
  const modeOptions = session.configOptions?.filter((option) => option.category === 'mode') ?? []
  const modelOptions = session.configOptions?.filter((option) => option.category === 'model') ?? []
  const dedicatedIds = new Set([
    ...(modeOptions.length === 1 && (session.modes?.length ?? 0) > 0 && controls.includes('session/set_mode') ? [modeOptions[0].id] : []),
    ...(modelOptions.length === 1 && (session.models?.length ?? 0) > 0 && controls.includes('session/set_model') ? [modelOptions[0].id] : [])
  ])
  return <div className="space-y-4 text-my-xs text-my-secondary">
    <div><h3 className="font-medium text-my-primary">会话实际配置</h3><p className="mt-1 text-my-2xs text-my-tertiary">本机执行 · 配置变更需 Runtime 确认；仅在就绪时可修改。</p></div>
    <dl className="space-y-2 break-all text-my-2xs">
      <div><dt className="text-my-tertiary">Agent</dt><dd>{session.profileSnapshot?.name ?? session.agentName}</dd></div>
      <div><dt className="text-my-tertiary">Runtime</dt><dd>{session.runtimeSnapshot?.name ?? session.agentName}</dd></div>
      <div><dt className="text-my-tertiary">工作目录</dt><dd className="font-mono">{session.cwd ?? session.projectRoot}</dd></div>
      <div><dt className="text-my-tertiary">单轮最长运行</dt><dd>{session.profileSnapshot?.maxTurnMinutes ?? 30} 分钟</dd></div>
    </dl>
    <label className="block">模型{(session.models?.length ?? 0) > 0 ? <select aria-label="会话模型" className="my-input mt-1 w-full" disabled={disabled || !controls.includes('session/set_model')} value={session.currentModelId ?? ''} onChange={(event) => void configure({ kind: 'model', id: event.target.value })}>
      {!session.currentModelId && <option value="">未报告当前模型</option>}{session.models?.map((model) => <option key={model.modelId} value={model.modelId}>{model.name}</option>)}
    </select> : <p className="mt-1 text-my-2xs text-my-tertiary">{session.currentModelId ?? 'Runtime 未提供可切换模型'}</p>}</label>
    <label className="block">模式{(session.modes?.length ?? 0) > 0 ? <select aria-label="会话模式" className="my-input mt-1 w-full" disabled={disabled || !controls.includes('session/set_mode')} value={session.currentModeId ?? ''} onChange={(event) => void configure({ kind: 'mode', id: event.target.value })}>
      {!session.currentModeId && <option value="">未报告当前模式</option>}{session.modes?.map((mode) => <option key={mode.id} value={mode.id}>{mode.name}</option>)}
    </select> : <p className="mt-1 text-my-2xs text-my-tertiary">Runtime 未提供可切换模式</p>}</label>
    {session.configOptions?.filter((option) => !dedicatedIds.has(option.id)).map((option) => <label key={option.id} className="block">{option.name}<select aria-label={option.name} className="my-input mt-1 w-full" disabled={disabled || !controls.includes('session/set_config_option')} value={option.currentValue} onChange={(event) => void configure({ kind: 'config', id: option.id, value: event.target.value })}>{option.options.map((value) => <option key={value.value} value={value.value}>{value.name}</option>)}</select></label>)}
    {pending && <p role="status" className="flex items-center gap-1 text-my-2xs"><Loader2 size={12} className="animate-spin" />等待 Runtime 确认…</p>}
    {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}{notice && <p role="status" className="text-my-2xs text-my-success-text">{notice}</p>}
    <details className="border-t border-my-line pt-3"><summary className="cursor-pointer">发送材料与指令快照</summary><div className="mt-2 space-y-2 text-my-2xs">
      {session.materialSnapshot ? <><p>捕获于 {new Date(session.materialSnapshot.capturedAt).toLocaleString()}</p><pre className="whitespace-pre-wrap break-words">{session.materialSnapshot.instructions || '未配置附加指令'}</pre><ul className="break-all">{session.materialSnapshot.files.map((file) => <li key={file}>{file}</li>)}</ul><p className="text-my-tertiary">材料快照表示已组装的输入；不代表模型已遵循或任务已验收。</p></> : <p>{session.schemaVersion === 2 ? '尚未发送材料；发送后显示本轮快照。' : '旧会话未记录材料快照。'}</p>}
    </div></details>
    <details className="border-t border-my-line pt-3"><summary className="cursor-pointer">连接与协议诊断</summary><dl className="mt-2 space-y-2 break-all font-mono text-my-2xs">
      <div><dt>面板会话</dt><dd>{session.sessionId}</dd></div><div><dt>远端 ACP 会话</dt><dd>{session.backendSessionId ?? '未记录'}</dd></div><div><dt>原生 Agent 会话</dt><dd>{session.agentSessionId ?? '未报告'}</dd></div><div><dt>连接代次</dt><dd>{session.connectionGeneration ?? '未记录'}</dd></div><div><dt>ACP 版本</dt><dd>{session.capabilities?.protocolVersion ?? '未知'}</dd></div>
      <div><dt>Agent 信息与认证方式</dt><dd><pre className="whitespace-pre-wrap break-all">{JSON.stringify({ agentInfo: session.capabilities?.agentInfo, authMethods: session.capabilities?.authMethods }, null, 2)}</pre></dd></div>
    </dl></details>
  </div>
}
