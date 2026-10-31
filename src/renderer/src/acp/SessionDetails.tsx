import { isConversationRuntimeEvent } from './runtime-events'
import { useEffect, useRef, useState, type JSX } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '../api'
import { Select } from '../components/Select'
import { RunActivity } from './RunActivity'
import { asObject, isConnectionTimelineEvent } from './timeline'
import { projectRootKey } from '../my/navigation'
import type { AcpConfigureInput, AcpSessionRecord } from '../../../shared/types'
import { ACP_CONNECTION_STAGE_LABELS } from '@shared/acp-connection'
import type { AgentRuleEntry, TeamTaskRulesManifest } from '@shared/agent-rules'
import { relativePathUnderRoot, sameRelativeDocumentPath } from '../reader/reader-paths'

export function StartupGroup({ session }: { session: AcpSessionRecord }): JSX.Element {
  const events = session.events.filter((event) => isConversationRuntimeEvent(event) && event.sessionId === session.sessionId && projectRootKey(event.projectRoot) === projectRootKey(session.projectRoot) && event.connectionGeneration === session.connectionGeneration && isConnectionTimelineEvent(event))
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
    {!controlsOnly && <><ConnectionTimingDetails session={session} /><AgentContextDetails session={session} /><AgentRulesDetails session={session} /><details className="border-t border-my-line pt-3"><summary className="cursor-pointer">发送材料与指令快照</summary><div className="mt-2 space-y-2 text-my-sm">
      {session.materialSnapshot ? <><p>捕获于 {new Date(session.materialSnapshot.capturedAt).toLocaleString()}</p><pre className="whitespace-pre-wrap break-words">{session.materialSnapshot.instructions || '未配置附加指令'}</pre><ul className="break-all">{session.materialSnapshot.files.map((file) => <li key={file}>{file}</li>)}</ul>{session.materialSnapshot.sources?.map((source) => <details className="border-t border-my-line pt-2" key={source.relativePath}><summary className="cursor-pointer break-all">{source.relativePath} · {source.included ? `已包含 ${source.includedBytes} 字节` : source.status === 'missing' ? '文件缺失' : source.status === 'unreadable' ? '无法读取' : '未纳入'}{source.truncated ? ' · 已截断' : ''}</summary><dl className="mt-2 space-y-1 break-all"><div><dt>来源版本</dt><dd>{source.sourceRevision ?? '未知'} · {source.sourceBytes ?? '未知'} 字节</dd></div><div><dt>实际包含版本</dt><dd>{source.includedRevision ?? '未包含'} · {source.includedChars} 字符</dd></div><div><dt>包含范围</dt><dd>{source.extent.start}–{source.extent.end}（{source.extent.unit}）</dd></div></dl>{source.diagnostics?.map((notice) => <p key={notice}>{notice}</p>)}</details>)}<p className="text-my-tertiary">材料快照表示已组装的输入；不代表模型已遵循或任务已验收。</p></> : <p>{session.schemaVersion === 2 ? '尚未发送材料；发送后显示本轮快照。' : '旧会话未记录材料快照。'}</p>}
    </div></details>
    <details className="border-t border-my-line pt-3"><summary className="cursor-pointer">连接与协议诊断</summary><dl className="mt-2 space-y-2 break-all font-mono text-my-sm">
      <div><dt>面板会话</dt><dd>{session.sessionId}</dd></div><div><dt>引擎会话</dt><dd>{session.backendSessionId ?? '未记录'}</dd></div><div><dt>原生 Agent 会话</dt><dd>{session.agentSessionId ?? '未报告'}</dd></div><div><dt>连接代次</dt><dd>{session.connectionGeneration ?? '未记录'}</dd></div><div><dt>{session.engine === 'pi' ? 'Pi SDK 版本' : 'ACP 版本'}</dt><dd>{session.engine === 'pi' ? session.pi?.version ?? '未知' : session.capabilities?.protocolVersion ?? '未知'}</dd></div>
      {session.engine === 'pi' && session.pi && <div><dt>Pi 会话文件</dt><dd>{session.pi.sessionFile}</dd></div>}
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

function AgentRulesDetails({ session }: { session: AcpSessionRecord }): JSX.Element {
  const manifest = session.agentRulesManifest
  const [expanded, setExpanded] = useState(false)
  const reads = useRuleReadObservations(session, expanded)
  if (!manifest) return <></>
  const team = manifest.teamTask, omitted = team?.selected.filter(rule => rule.status === 'omitted') ?? []
  return <details className="border-t border-my-line pt-3" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer">规范依据 · {manifest.entries.length + omitted.length} 项</summary>
    <div className="mt-2 space-y-2 text-my-sm">
      {team && <dl className="space-y-1 break-all"><div><dt>原任务 / 空间</dt><dd>{team.taskId} / {team.spaceId}</dd></div><div><dt>固定输入版本</dt><dd className="font-mono">{team.inputVersion}</dd></div>{team.bundle && <div><dt>已采用规则包</dt><dd>R{team.bundle.revision} · {team.bundle.id}</dd></div>}</dl>}
      <p className="text-my-tertiary">以下记录已组装的正文与索引范围；本轮发送状态见交付回执。{reads.length ? 'Pi 工具返回的固定正文已单列观测；不代表模型已遵守。' : '读取与遵守尚无关联证据。'}</p>
      {manifest.entries.map(entry => <RuleSourceDetails key={entry.path} entry={entry} selected={team?.selected.find(rule => rule.path === entry.path)} read={reads.find(read => read.path === entry.path)} />)}
      {omitted.map(selected => <RuleSourceDetails key={selected.path} selected={selected} read={reads.find(read => read.path === selected.path)} />)}
    </div>
  </details>
}

type RuleReadObservation = { path: string; at: number; eventId: string; toolCallId: string; turnId: string }

/** Derive evidence from existing Pi events; only an exact returned body establishes a version. */
function useRuleReadObservations(session: AcpSessionRecord, enabled: boolean): RuleReadObservation[] {
  const manifest = session.agentRulesManifest
  const owner = JSON.stringify([session.sessionId, session.projectRoot, session.connectionGeneration, session.turnId, manifest?.digest])
  const [state, setState] = useState<{ owner: string; reads: RuleReadObservation[] }>({ owner: '', reads: [] })
  useEffect(() => {
    let current = true
    const collect = async (): Promise<RuleReadObservation[]> => {
      if (!enabled || session.engine !== 'pi' || !manifest || !session.turnId || !session.connectionGeneration || !globalThis.crypto?.subtle) return []
      const expected = [...manifest.entries.filter(entry => entry.version).map(entry => ({ path: entry.path, digest: entry.version, bytes: entry.totalBytes })),
        ...(manifest.teamTask?.selected ?? []).map(rule => ({ path: rule.path, digest: rule.version.bodyDigest, bytes: rule.version.byteLength }))]
      const starts = new Map<string, string>(), candidates = new Map<string, { event: typeof session.events[number]; body: string; digest: string }>()
      for (const event of session.events) {
        if (!Number.isFinite(event.ts) || event.source !== 'pi' || event.kind !== 'tool-call' || event.sessionId !== session.sessionId || event.connectionGeneration !== session.connectionGeneration
          || event.turnId !== session.turnId || projectRootKey(event.projectRoot) !== projectRootKey(session.projectRoot) || event.payload?.title !== 'read' || typeof event.payload.toolCallId !== 'string') continue
        const toolCallId = event.payload.toolCallId
        if (event.payload.tag === 'pi_tool_start') {
          starts.delete(toolCallId)
          const raw = asObject(event.payload.rawInput)?.path
          if (typeof raw !== 'string') continue
          const absolute = /^(?:[a-z]:[/\\]|[/\\])/i.test(raw) ? raw : `${session.cwd ?? session.projectRoot}/${raw}`
          const path = relativePathUnderRoot(session.projectRoot, absolute)
          if (path && path.split('/').every(part => part && part !== '.' && part !== '..')) starts.set(toolCallId, path)
        } else if (event.payload.tag === 'pi_tool_end') {
          const path = starts.get(toolCallId), output = asObject(event.payload.rawOutput), content = output?.content
          starts.delete(toolCallId)
          if (event.payload.status !== 'completed' || !path || output?.isError === true || !Array.isArray(content) || content.length !== 1) continue
          const block = asObject(content[0])
          if (block?.type !== 'text' || typeof block.text !== 'string') continue
          const selected = expected.find(ref => sameRelativeDocumentPath(session.projectRoot, ref.path, path))
          if (!selected?.digest || selected.bytes > 1024 * 1024 || block.text.length > selected.bytes || new TextEncoder().encode(block.text).byteLength !== selected.bytes) continue
          candidates.set(selected.path, { event, body: block.text, digest: selected.digest })
        }
      }
      const reads: RuleReadObservation[] = []
      for (const [path, candidate] of [...candidates].slice(0, 65)) {
        const checksum = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(candidate.body))
        const digest = [...new Uint8Array(checksum)].map(byte => byte.toString(16).padStart(2, '0')).join('')
        if (digest === candidate.digest) reads.push({ path, at: candidate.event.ts, eventId: candidate.event.id,
          toolCallId: String(candidate.event.payload?.toolCallId), turnId: session.turnId })
      }
      return reads
    }
    void collect().then(reads => { if (current) setState({ owner, reads }) }, () => { if (current) setState({ owner, reads: [] }) })
    return () => { current = false }
  }, [enabled, owner, manifest, session.engine, session.events, session.cwd, session.projectRoot, session.sessionId, session.connectionGeneration, session.turnId])
  return state.owner === owner ? state.reads : []
}

function RuleSourceDetails({ entry, selected, read }: { entry?: AgentRuleEntry; selected?: TeamTaskRulesManifest['selected'][number]; read?: RuleReadObservation }): JSX.Element {
  const path = entry?.path ?? selected?.path ?? '', version = selected?.version, settings = version?.settings
  const scope = settings?.kind === 'rule' ? [
    settings.applicability.modules.length ? `模块：${settings.applicability.modules.join('、')}` : '',
    settings.applicability.paths.length ? `路径：${settings.applicability.paths.join('、')}` : '',
    settings.applicability.stages.length ? `阶段：${settings.applicability.stages.join('、')}` : '',
    settings.applicability.taskTypeIds.length ? `任务类型：${settings.applicability.taskTypeIds.join('、')}` : ''
  ].filter(Boolean).join('；') || '采用范围内通用' : '已采用流程模板'
  const extent = !entry ? '未纳入' : entry.includedBytes ? entry.truncated ? '正文片段' : '正文完整' : '仅索引'
  return <details className="border-t border-my-line pt-2">
    <summary className="cursor-pointer break-words">{version?.title ?? path} · {extent}{settings ? settings.kind === 'rule' ? ` · ${settings.obligation === 'required' ? '必需' : '建议'}` : ' · 必需模板' : ''}</summary>
    {read && <dl className="mt-2 space-y-1 break-all"><div><dt>读取观测</dt><dd>Pi 原生 read · {new Date(read.at).toLocaleTimeString()} · 已返回固定版本全文</dd></div><div><dt>原工具事件 / 轮次</dt><dd className="font-mono">{read.eventId} / {read.toolCallId} / {read.turnId}</dd></div></dl>}
    <dl className="mt-2 space-y-1 break-all text-my-tertiary"><div><dt>固定来源</dt><dd className="font-mono">{path}</dd></div><div><dt>版本</dt><dd>{version ? `R${version.number} · ${version.versionId}` : entry?.declaredVersion ?? entry?.version ?? '未取得完整摘要'}</dd></div><div><dt>组装范围</dt><dd>正文前 {entry?.includedBytes ?? 0} / {entry?.totalBytes ?? version?.byteLength ?? 0} 字节{entry?.truncated ? ' · 未完整纳入' : ''}</dd></div>{version && <><div><dt>适用范围</dt><dd>{scope}</dd></div><div><dt>正文摘要</dt><dd className="font-mono">{version.bodyDigest}</dd></div>{settings?.kind === 'rule' && <div><dt>优先级</dt><dd>{settings.priority}</dd></div>}</>}{selected?.reason && <div><dt>未完整纳入原因</dt><dd>{selected.reason === 'source-limit' ? '来源数量上限' : selected.reason === 'byte-limit' ? '单份正文大小上限' : '上下文预算上限'}</dd></div>}</dl>
  </details>
}
