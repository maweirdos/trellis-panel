import { useRef, useState, type JSX } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '../api'
import { Select } from '../components/Select'
import { RunActivity } from './RunActivity'
import { asObject, isConnectionTimelineEvent } from './timeline'
import { projectRootKey } from '../my/navigation'
import type { AcpConfigureInput, AcpSessionRecord } from '../../../shared/types'
import { ACP_CONNECTION_STAGE_LABELS } from '@shared/acp-connection'

export function StartupGroup({ session }: { session: AcpSessionRecord }): JSX.Element {
  const events = session.events.filter((event) => event.source === 'acp' && event.sessionId === session.sessionId && projectRootKey(event.projectRoot) === projectRootKey(session.projectRoot) && event.connectionGeneration === session.connectionGeneration && isConnectionTimelineEvent(event))
  if (!events.length) return <></>
  const label = (event: typeof events[number]): unknown => asObject(event.payload?.observation)?.label
  const start = events.find((event) => ['开始准备会话', '开始恢复原会话'].includes(String(label(event))))
  const ready = events.find((event) => ['ACP 会话已就绪', '原会话已连接，可以继续对话'].includes(String(label(event))))
  const failure = events.find((event) => asObject(event.payload?.observation)?.status === 'failed')
  const terminal = failure ?? ready
  return <RunActivity session={session} item={{ type: 'activity', scope: 'connection', key: `startup:${session.sessionId}:${session.connectionGeneration}`, events, sessionId: session.sessionId, projectRoot: session.projectRoot, connectionGeneration: session.connectionGeneration, startedAt: start?.ts, endedAt: terminal?.ts, outcome: failure ? 'failed' : ready ? 'completed' : undefined, active: !terminal }} />
}

export function SessionDetails({ session, isCurrent, onUpdated, controlsOnly = false, detailsOnly = false }: {
  session: AcpSessionRecord
  isCurrent: () => boolean
  onUpdated: (session: AcpSessionRecord) => void
  controlsOnly?: boolean
  detailsOnly?: boolean
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
      if (res.ok && res.session) { onUpdated(res.session); setNotice('执行引擎已确认配置生效。') }
      else setError(res.error ?? '执行引擎尚未确认配置，保留原生效值。')
    } catch (err) { if (isCurrent()) setError(err instanceof Error ? err.message : '配置失败，保留原生效值。') }
    finally { lock.current = false; if (isCurrent()) setPending('') }
  }
  const controls = session.capabilities?.controls ?? []
  const connectionEvents = session.events.filter(isConnectionTimelineEvent)
  const disabled = session.status !== 'ready' || Boolean(pending)
  const modeOptions = session.configOptions?.filter((option) => option.category === 'mode') ?? []
  const modelOptions = session.configOptions?.filter((option) => option.category === 'model') ?? []
  const modeConfig = modeOptions.length === 1 && controls.includes('session/set_config_option') ? modeOptions[0] : undefined
  const modelConfig = modelOptions.length === 1 && controls.includes('session/set_config_option') ? modelOptions[0] : undefined
  const modelCatalog = session.modelCatalog?.connectionGeneration === session.connectionGeneration ? session.modelCatalog : undefined
  const modelNotice = modelCatalog?.reloadRequired ? '模型配置已变化；新目录需在引擎进程重新加载后生效，当前生效模型保持原值。'
    : modelCatalog?.issue === 'catalog-not-advertised' ? '执行引擎尚未提供 CC Switch 目录中的聚合模型；请检查引擎目录支持并重新连接。'
    : modelCatalog?.issue === 'configuration-unknown' ? '本地模型配置来源暂无法确认；以执行引擎返回值为准。' : undefined
  const dedicatedIds = new Set([
    ...(modeOptions.length === 1 && (session.modes?.length ?? 0) > 0 && (modeConfig || controls.includes('session/set_mode')) ? [modeOptions[0].id] : []),
    ...(modelOptions.length === 1 && (session.models?.length ?? 0) > 0 && (modelConfig || controls.includes('session/set_model')) ? [modelOptions[0].id] : [])
  ])
  return <div className="space-y-4 text-my-sm text-my-secondary">
    <div><h3 className="font-medium text-my-primary">{detailsOnly ? '会话环境与材料' : '模型与会话配置'}</h3><p className="mt-1 text-my-sm text-my-tertiary">本机执行 · 配置变更需执行引擎确认；仅在就绪时可修改。</p>{!detailsOnly && session.status !== 'ready' && <p className="mt-2 text-my-sm text-my-warning-text">{session.status === 'starting' ? '正在连接，模型与模式将在引擎返回后显示。' : session.restorePending ? '原会话尚待恢复验证，实际连接就绪后才能修改模型。' : '当前会话尚未就绪，请等待运行结束或处理连接错误后再修改。'}</p>}</div>
    {!controlsOnly && <dl className="space-y-2 break-all text-my-sm">
      <div><dt className="text-my-tertiary">角色</dt><dd>{session.profileSnapshot?.name ?? session.agentName}</dd></div>
      <div><dt className="text-my-tertiary">执行引擎</dt><dd>{session.runtimeSnapshot?.name ?? session.agentName}</dd></div>
      <div><dt className="text-my-tertiary">工作目录</dt><dd className="font-mono">{session.cwd ?? session.projectRoot}</dd></div>
      <div><dt className="text-my-tertiary">单轮最长运行</dt><dd>{session.profileSnapshot?.maxTurnMinutes ?? 30} 分钟</dd></div>
      {modelNotice && <div role="status"><dt className="text-my-tertiary">模型目录</dt><dd>{modelNotice}</dd></div>}
    </dl>}
    {!detailsOnly && <><label className="block">模型{(session.models?.length ?? 0) > 0 ? <Select ariaLabel="会话模型" className="mt-1 w-full" disabled={disabled || (!modelConfig && !controls.includes('session/set_model'))} value={session.currentModelId ?? ''} onChange={(value) => void configure(modelConfig ? { kind: 'config', id: modelConfig.id, value } : { kind: 'model', id: value })} options={[
      ...(!session.currentModelId ? [{ value: '', label: '未报告当前模型', disabled: true }] : !session.models?.some(({ modelId }) => modelId === session.currentModelId) ? [{ value: session.currentModelId, label: `${session.currentModelId}（当前模型不在候选中）`, disabled: true }] : []),
      ...(session.models ?? []).map((model) => ({ value: model.modelId, label: model.name }))
    ]} /> : <p className="mt-1 text-my-sm text-my-tertiary">{session.currentModelId ?? '执行引擎未提供可切换模型'}</p>}</label>
    <label className="block">模式{(session.modes?.length ?? 0) > 0 ? <Select ariaLabel="会话模式" className="mt-1 w-full" disabled={disabled || (!modeConfig && !controls.includes('session/set_mode'))} value={session.currentModeId ?? ''} onChange={(value) => void configure(modeConfig ? { kind: 'config', id: modeConfig.id, value } : { kind: 'mode', id: value })} options={[
      ...(!session.currentModeId ? [{ value: '', label: '未报告当前模式' }] : []),
      ...(session.modes ?? []).map((mode) => ({ value: mode.id, label: mode.name }))
    ]} /> : <p className="mt-1 text-my-sm text-my-tertiary">执行引擎未提供可切换模式</p>}</label>
    {session.configOptions?.filter((option) => !dedicatedIds.has(option.id)).map((option) => <label key={option.id} className="block">{option.name}<Select ariaLabel={option.name} className="mt-1 w-full" disabled={disabled || !controls.includes('session/set_config_option')} value={option.currentValue} onChange={(value) => void configure({ kind: 'config', id: option.id, value })} options={option.options.map((value) => ({ value: value.value, label: value.name }))} /></label>)}
    {pending && <p role="status" className="flex items-center gap-1 text-my-sm"><Loader2 size={12} className="animate-spin" />等待执行引擎确认…</p>}
    {error && <p role="alert" className="text-my-sm text-my-danger-text">{error}</p>}{notice && <p role="status" className="text-my-sm text-my-success-text">{notice}</p>}</>}
    {!controlsOnly && <><ConnectionTimingDetails session={session} /><AgentContextDetails session={session} /><details className="border-t border-my-line pt-3"><summary className="cursor-pointer">发送材料与指令快照</summary><div className="mt-2 space-y-2 text-my-sm">
      {session.materialSnapshot ? <><p>捕获于 {new Date(session.materialSnapshot.capturedAt).toLocaleString()}</p><pre className="whitespace-pre-wrap break-words">{session.materialSnapshot.instructions || '未配置附加指令'}</pre><ul className="break-all">{session.materialSnapshot.files.map((file) => <li key={file}>{file}</li>)}</ul>{session.materialSnapshot.sources?.map((source) => <details className="border-t border-my-line pt-2" key={source.relativePath}><summary className="cursor-pointer break-all">{source.relativePath} · {source.included ? `已包含 ${source.includedBytes} 字节` : source.status === 'missing' ? '文件缺失' : source.status === 'unreadable' ? '无法读取' : '未纳入'}{source.truncated ? ' · 已截断' : ''}</summary><dl className="mt-2 space-y-1 break-all"><div><dt>来源版本</dt><dd>{source.sourceRevision ?? '未知'} · {source.sourceBytes ?? '未知'} 字节</dd></div><div><dt>实际包含版本</dt><dd>{source.includedRevision ?? '未包含'} · {source.includedChars} 字符</dd></div><div><dt>包含范围</dt><dd>{source.extent.start}–{source.extent.end}（{source.extent.unit}）</dd></div></dl>{source.diagnostics?.map((notice) => <p key={notice}>{notice}</p>)}</details>)}<p className="text-my-tertiary">材料快照表示已组装的输入；不代表模型已遵循或任务已验收。</p></> : <p>{session.schemaVersion === 2 ? '尚未发送材料；发送后显示本轮快照。' : '旧会话未记录材料快照。'}</p>}
    </div></details>
    <details className="border-t border-my-line pt-3"><summary className="cursor-pointer">连接与协议诊断</summary><dl className="mt-2 space-y-2 break-all font-mono text-my-sm">
      <div><dt>面板会话</dt><dd>{session.sessionId}</dd></div><div><dt>远端 ACP 会话</dt><dd>{session.backendSessionId ?? '未记录'}</dd></div><div><dt>原生 Agent 会话</dt><dd>{session.agentSessionId ?? '未报告'}</dd></div><div><dt>连接代次</dt><dd>{session.connectionGeneration ?? '未记录'}</dd></div><div><dt>ACP 版本</dt><dd>{session.capabilities?.protocolVersion ?? '未知'}</dd></div>
      <div><dt>Agent 信息与认证方式</dt><dd><pre className="whitespace-pre-wrap break-all">{JSON.stringify({ agentInfo: session.capabilities?.agentInfo, authMethods: session.capabilities?.authMethods }, null, 2)}</pre></dd></div>
      {modelCatalog?.provenance && <div><dt>CC Switch 配置来源</dt><dd>{modelCatalog.provenance.app} · {modelCatalog.provenance.transportMode} · {modelCatalog.provenance.attached ? '已附加' : '未附加'} · 聚合{modelCatalog.provenance.aggregateEnabled ? '已配置' : '未配置'}</dd></div>}
      {modelCatalog?.mappings?.filter(({ modelId }) => modelId === session.currentModelId).map((mapping) => <div key={mapping.modelId}><dt>配置的目标模型（非实际应答证明）</dt><dd>{mapping.providerKey ? `${mapping.providerKey} · ` : ''}{mapping.configuredModel}</dd></div>)}
    </dl>{connectionEvents.length > 0 && <details className="mt-3"><summary className="cursor-pointer">连接记录 · {connectionEvents.length}</summary><ol className="mt-2 space-y-1">{connectionEvents.map((event) => <li key={event.id} className="flex items-start gap-2 text-my-sm"><time className="shrink-0 text-my-tertiary">{new Date(event.ts).toLocaleTimeString()}</time><span className="min-w-0 break-words">{event.text ?? '连接状态更新'}</span></li>)}</ol></details>}</details></>}
  </div>
}

function ConnectionTimingDetails({ session }: { session: AcpSessionRecord }): JSX.Element {
  const timing = session.connectionTimings
  if (!timing || timing.connectionGeneration !== session.connectionGeneration) return <></>
  return <details className="border-t border-my-line pt-3">
    <summary className="cursor-pointer">连接耗时 · {(timing.totalDurationMs / 1000).toFixed(2)} 秒</summary>
    <dl className="mt-2 space-y-2 text-my-sm">{timing.stages.map((stage) => <div key={stage.stage} className="flex items-center justify-between gap-3">
      <dt className="text-my-secondary">{ACP_CONNECTION_STAGE_LABELS[stage.stage]}</dt>
      <dd className={stage.status === 'failed' ? 'text-my-danger-text' : 'text-my-tertiary'}>{stage.status === 'skipped' ? '未执行' : `${stage.status === 'failed' ? '失败 · ' : ''}${((stage.durationMs ?? 0) / 1000).toFixed(2)} 秒`}</dd>
    </div>)}</dl>
  </details>
}

function AgentContextDetails({ session }: { session: AcpSessionRecord }): JSX.Element {
  const receipt = session.agentContext
  const current = receipt && session.connectionGeneration && session.turnId
    && receipt.connectionGeneration === session.connectionGeneration && receipt.turnId === session.turnId ? receipt : undefined
  const state = current?.state === 'sent' ? '已发送' : current?.state === 'not_sent' ? '未发送' : current?.state === 'prepared' ? '已准备' : '未记录本轮回执'
  return <details className="border-t border-my-line pt-3">
    <summary className="cursor-pointer">角色与技能交付 · {state}</summary>
    <div className="mt-2 space-y-2 text-my-sm">
      {current ? <>
        <p>角色指令：{current.instructionsProvided ? '已包含' : '未包含'} · 项目技能：{current.skills.length} 个</p>
        {current.skills.length > 0 && <ul className="space-y-2">{current.skills.map((skill) => <li key={skill.relativePath}><strong className="font-medium text-my-primary">{skill.name}</strong><p className="break-words text-my-tertiary">{skill.description}</p><p className="break-all font-mono">{skill.relativePath}</p><p className="break-all font-mono text-my-xs text-my-tertiary">版本 {skill.revision}</p></li>)}</ul>}
        <dl className="space-y-1 break-all text-my-tertiary"><div><dt>连接代次 / 轮次</dt><dd className="font-mono">{current.connectionGeneration} / {current.turnId}</dd></div><div><dt>交付方式</dt><dd>{current.method}</dd></div><div><dt>上下文版本</dt><dd className="font-mono">{current.revision}</dd></div><div><dt>资源</dt><dd className="font-mono">{current.uri}</dd></div></dl>
        <p className="text-my-tertiary">交付回执仅记录发送状态，无法确认模型已读取或遵循。</p>
      </> : <p className="text-my-tertiary">当前连接与轮次没有可核对的角色与技能交付回执。</p>}
      {session.capabilities?.promptCapabilities?.embeddedContext !== true && <p className="text-my-tertiary">当前连接未声明支持角色与技能附件。</p>}
    </div>
  </details>
}
