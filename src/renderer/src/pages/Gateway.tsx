import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  RefreshCw,
  Terminal,
  Activity,
  Copy,
  Check,
  Loader2,
  X,
  ShieldCheck,
  Play
} from 'lucide-react'
import { useApp } from '../store'
import { api, hasIpc } from '../api'
import { clsx } from 'clsx'
import { Button, Checkbox, Modal } from '../my/ui'
import { relTime } from '../utils/format'
import { errorMessage } from '../../../shared/errors'
import { knowledgeStatusLabel, useProjectKnowledge } from '../knowledge/bridge'
import { PreferenceRow, PreferenceSection } from './settings/PreferenceSection'
import { useCopyFeedback } from '../utils/use-copy-feedback'
import { useInteractionGuard } from '../utils/interaction-scope'
import type {
  GatewaySecurityConfig,
  GatewayStatus,
  GatewayTestToolResult,
  GatewayToolDef,
  KbMcpInstallResult
} from '../../../shared/types'
import type { JSX } from 'react'

export function GatewayPage(): JSX.Element {
  const root = useApp((s) => s.snapshot?.meta.root ?? '')
  return <GatewayWorkspace key={root} root={root} />
}

function GatewayWorkspace({ root }: { root: string }): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const knowledge = useProjectKnowledge(root)
  const pushToast = useApp((s) => s.pushToast)
  const setPage = useApp((s) => s.setPage)

  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null)
  const canReadStatus = hasIpc && typeof api?.gatewayStatus === 'function'
  const [loadingStatus, setLoadingStatus] = useState(canReadStatus)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<{ kind: 'mount' | 'upstream'; detail: string; upstreamId?: string } | null>(null)
  const [testingUpstreamId, setTestingUpstreamId] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const mounted = useRef(false)
  const statusGeneration = useRef(0)
  const debuggerGeneration = useRef(0)
  const securityGeneration = useRef(0)
  const securityInitialized = useRef(false)
  const canInteract = useInteractionGuard()
  const projectCurrent = knowledge.current
  const ownsProject = useCallback(() => mounted.current && canInteract() && projectCurrent(), [canInteract, projectCurrent])

  // 调试器状态
  const [selectedTool, setSelectedTool] = useState<GatewayToolDef | null>(null)
  const [toolArgs, setToolArgs] = useState<Record<string, string>>({})
  const [executingTool, setExecutingTool] = useState(false)
  const [testResult, setTestResult] = useState<GatewayTestToolResult | null>(null)
  const [executionError, setExecutionError] = useState<string | null>(null)

  // 过滤分类
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'knowledge' | 'project'>('all')

  // 接入弹窗 & 安全配置弹窗
  const [showMountModal, setShowMountModal] = useState(false)
  const [showSecurityModal, setShowSecurityModal] = useState(false)
  const [mcpInstallResult, setMcpInstallResult] = useState<KbMcpInstallResult | null>(null)
  const [installingMcp, setInstallingMcp] = useState(false)
  const [savingSecurity, setSavingSecurity] = useState(false)
  const [securityError, setSecurityError] = useState<string | null>(null)
  const copyOwner = useMemo(() => ({ root, result: mcpInstallResult, open: showMountModal }), [root, mcpInstallResult, showMountModal, projectCurrent])
  const copyFeedback = useCopyFeedback(copyOwner)

  // 安全配置表单
  const [securityForm, setSecurityForm] = useState<GatewaySecurityConfig>({
    sqlReadOnly: true,
    timeoutMs: 2000,
    maxResponseChars: 12000
  })

  useLayoutEffect(() => {
    mounted.current = true
    // A batched A → B → A transition still revokes pending actions and dialogs.
    setGatewayStatus(null)
    setStatusError(null)
    setActionError(null)
    setTestingUpstreamId(null)
    setSelectedTool(null)
    setExecutingTool(false)
    setTestResult(null)
    setExecutionError(null)
    setShowMountModal(false)
    setShowSecurityModal(false)
    setMcpInstallResult(null)
    setInstallingMcp(false)
    setSavingSecurity(false)
    setSecurityError(null)
    securityInitialized.current = false
    return () => { mounted.current = false; statusGeneration.current++; debuggerGeneration.current++; securityGeneration.current++ }
  }, [projectCurrent])

  const loadStatus = useCallback(async (): Promise<void> => {
    if (!canReadStatus || !ownsProject()) return
    const ticket = ++statusGeneration.current
    const isCurrent = (): boolean => ownsProject() && ticket === statusGeneration.current
    setLoadingStatus(true)
    try {
      const res = await api.gatewayStatus()
      if (!isCurrent()) return
      if (!res?.ok) throw new Error('网关未返回有效状态')
      setGatewayStatus(res)
      setStatusError(null)
      if (!securityInitialized.current) {
        securityInitialized.current = true
        setSecurityForm(res.security)
      }
    } catch (e) {
      if (isCurrent()) setStatusError(errorMessage(e) || String(e))
    } finally {
      if (isCurrent()) setLoadingStatus(false)
    }
  }, [canReadStatus, ownsProject])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const handleTestUpstream = async (upstreamId: string) => {
    if (!root || !ownsProject() || !gatewayStatus || statusError || testingUpstreamId || typeof api?.gatewayTestProvider !== 'function') return
    setTestingUpstreamId(upstreamId)
    setActionError(null)
    try {
      const res = await api.gatewayTestProvider(upstreamId)
      if (!ownsProject()) return
      if (res.ok) {
        pushToast({ kind: 'success', title: `上游服务 [${upstreamId}] 连通性测试通过！` })
      } else {
        setActionError({ kind: 'upstream', upstreamId, detail: res.error || '未知错误' })
      }
      void loadStatus()
    } catch (e) {
      if (ownsProject()) setActionError({ kind: 'upstream', upstreamId, detail: errorMessage(e) || String(e) })
    } finally {
      if (ownsProject()) setTestingUpstreamId(null)
    }
  }

  const handleOpenDebugger = (tool: GatewayToolDef) => {
    if (!root || !ownsProject() || statusError || typeof api?.gatewayTestTool !== 'function') return
    debuggerGeneration.current++
    setSelectedTool(tool)
    setExecutionError(null)
    setTestResult(null)
    // 设置默认参数
    const defaults: Record<string, string> = {}
    if (tool.name === 'kb_search') {
      defaults.query = '项目的开发流程是什么'
    } else if (tool.name === 'kb_read_doc') {
      defaults.docId = ''
    } else if (tool.name === 'weknora_search') {
      defaults.query = '退货审核流程规范'
      defaults.limit = '5'
    } else if (tool.name === 'trellis_get_spec') {
      defaults.name = 'workflow.md'
    } else if (tool.name === 'trellis_get_task') {
      defaults.taskDir = snapshot?.tasks?.[0]?.dirName || '001-task'
    }
    setToolArgs(defaults)
  }

  const handleExecuteTool = async () => {
    if (!root || !selectedTool || !ownsProject() || executingTool || statusError || typeof api?.gatewayTestTool !== 'function') return
    const ticket = ++debuggerGeneration.current
    const isCurrent = (): boolean => ownsProject() && debuggerGeneration.current === ticket
    setExecutingTool(true)
    setTestResult(null)
    setExecutionError(null)
    try {
      const parsedArgs: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(toolArgs)) {
        if (k === 'limit') {
          parsedArgs[k] = Number(v) || 10
        } else {
          parsedArgs[k] = v
        }
      }

      const res = await api.gatewayTestTool(selectedTool.name, parsedArgs)
      if (!isCurrent()) return
      setTestResult(res)
      if (res.blockedBySecurity) {
        pushToast({ kind: 'warn', title: '网关安全防线拦截：禁止破坏性操作！' })
      } else if (res.ok) {
        pushToast({ kind: 'success', title: `工具 [${selectedTool.name}] 执行完成 (${res.elapsedMs}ms)` })
      } else {
        pushToast({ kind: 'error', title: `执行失败: ${res.error || '未知错误'}` })
      }
      void loadStatus()
    } catch (e) {
      if (isCurrent()) setExecutionError(errorMessage(e) || String(e))
    } finally {
      if (isCurrent()) setExecutingTool(false)
    }
  }

  const handleSaveSecurity = async () => {
    if (!ownsProject() || savingSecurity || statusError || typeof api?.gatewayUpdateSecurity !== 'function') return
    const ticket = ++securityGeneration.current
    setSavingSecurity(true)
    setSecurityError(null)
    try {
      const res = await api.gatewayUpdateSecurity(securityForm)
      if (!ownsProject() || securityGeneration.current !== ticket) return
      if (!res.ok) throw new Error('安全策略未保存，请重试')
      pushToast({ kind: 'success', title: '网关安全策略已更新' })
      setShowSecurityModal(false)
      void loadStatus()
    } catch (e) {
      if (ownsProject() && securityGeneration.current === ticket) setSecurityError(errorMessage(e) || String(e))
    } finally {
      if (ownsProject()) setSavingSecurity(false)
    }
  }

  const handleOpenMountModal = async () => {
    if (!root || !ownsProject() || installingMcp || statusError || typeof api?.kbMcpInstall !== 'function') return
    setInstallingMcp(true)
    setActionError(null)
    try {
      const res = await api.kbMcpInstall()
      if (!ownsProject()) return
      if (!res.ok) throw new Error(res.error || '接入配置生成失败')
      setMcpInstallResult(res)
      setShowMountModal(true)
    } catch (e) {
      if (ownsProject()) setActionError({ kind: 'mount', detail: errorMessage(e) || String(e) })
    } finally {
      if (ownsProject()) setInstallingMcp(false)
    }
  }

  const copySnippet = async (key: string, text: string): Promise<void> => {
    if (copyFeedback.status === 'copying') return
    setCopiedKey(key)
    await copyFeedback.copy(text)
  }

  const closeDebugger = (): void => { debuggerGeneration.current++; setSelectedTool(null); setExecutingTool(false) }
  const closeSecurity = (): void => { securityGeneration.current++; setShowSecurityModal(false) }
  const actionsAvailable = !!gatewayStatus && !statusError
  const canTestUpstream = !!root && actionsAvailable && !testingUpstreamId && typeof api?.gatewayTestProvider === 'function'

  const upstreams = gatewayStatus?.upstreams.filter((upstream) => upstream.id !== 'custom') || []
  const tools = gatewayStatus?.tools || []
  const filteredTools = tools.filter((t) => {
    if (categoryFilter === 'all') return true
    if (categoryFilter === 'knowledge') return t.upstreamId === 'local-kb' || t.upstreamId === 'weknora'
    if (categoryFilter === 'project') return t.upstreamId === 'trellis'
    return true
  })

  const recentLogs = gatewayStatus?.recentLogs || []

  return (
    <div className="preferences-page min-w-0">
      <PreferenceSection id="gateway-connection" title="连接">
        <PreferenceRow label="网关状态" hint={gatewayStatus ? gatewayStatus.transport : undefined}>
          <span role="status" className={clsx('my-chip', gatewayStatus?.running && !statusError && !loadingStatus ? 'bg-my-success-subtle text-my-success-text' : 'bg-my-layer-3 text-my-tertiary')}>
            {loadingStatus ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
            {!hasIpc ? '桌面功能不可用' : statusError ? '状态待确认' : loadingStatus ? '正在读取状态' : gatewayStatus ? gatewayStatus.running ? '运行中' : '已停止' : '状态未知'}
          </span>
          {hasIpc && !root && <span className="my-chip bg-my-layer-3 text-my-tertiary">未打开项目</span>}
          <Button variant="outline" size="sm" onClick={loadStatus} disabled={!canReadStatus || loadingStatus}>
            <RefreshCw size={12} className={clsx(loadingStatus && 'animate-spin')} />
            刷新
          </Button>
        </PreferenceRow>
        <PreferenceRow label="安全策略" hint={gatewayStatus ? <span className={gatewayStatus.security.sqlReadOnly ? undefined : 'text-my-warning-text'}>{gatewayStatus.security.sqlReadOnly ? 'SQL 只读' : 'SQL 写操作拦截已关闭'} · {gatewayStatus.security.timeoutMs}ms 超时 · 响应上限 {gatewayStatus.security.maxResponseChars} 字符</span> : '状态未知'}>
          <Button
            variant="outline" size="sm"
            onClick={() => setShowSecurityModal(true)}
            disabled={!actionsAvailable || savingSecurity && !showSecurityModal || installingMcp || typeof api?.gatewayUpdateSecurity !== 'function'}
          >
            <ShieldCheck size={13} />
            配置
          </Button>
        </PreferenceRow>
        <PreferenceRow label="AI 编辑器">
          <Button variant="outline" size="sm" onClick={handleOpenMountModal} disabled={!root || !actionsAvailable || installingMcp || typeof api?.kbMcpInstall !== 'function'}>
            {installingMcp ? <Loader2 size={12} className="animate-spin" /> : <Terminal size={12} />}
            {installingMcp ? '正在生成配置' : '接入 AI 编辑器'}
          </Button>
        </PreferenceRow>
      </PreferenceSection>

      {statusError && (
        <div role="alert" className="flex items-start gap-3 rounded-my-lg border border-my-line p-3 text-my-xs">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-my-danger-text" />
          <div className="min-w-0 flex-1">
            <div className="text-my-primary">{gatewayStatus ? '刷新失败，保留上次网关记录' : '无法读取网关状态'}</div>
            <details className="mt-1 text-my-tertiary"><summary className="cursor-pointer">错误详情</summary><p className="mt-1 whitespace-pre-wrap break-words">{statusError}</p></details>
          </div>
          <Button variant="outline" size="sm" onClick={loadStatus} disabled={loadingStatus}>{loadingStatus ? '读取中' : '重试'}</Button>
        </div>
      )}
      {actionError && (
        <div role="alert" className="flex items-start gap-3 rounded-my-lg border border-my-line p-3 text-my-xs">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-my-danger-text" />
          <div className="min-w-0 flex-1">
            <div className="text-my-primary">{actionError.kind === 'mount' ? '接入配置生成失败' : '上游连通性测试失败'}</div>
            <details className="mt-1 text-my-tertiary"><summary className="cursor-pointer">错误详情</summary><p className="mt-1 whitespace-pre-wrap break-words">{actionError.detail}</p></details>
          </div>
          <Button variant="outline" size="sm" disabled={!actionsAvailable || installingMcp || !!testingUpstreamId} onClick={() => actionError.kind === 'mount' ? void handleOpenMountModal() : actionError.upstreamId && void handleTestUpstream(actionError.upstreamId)}>重试</Button>
        </div>
      )}
      {!gatewayStatus && !statusError && (
        <div role="status" className="flex items-center gap-3 rounded-my-lg border border-my-line p-4 text-my-sm text-my-tertiary">
          {loadingStatus ? <Loader2 size={18} className="shrink-0 animate-spin" /> : <Terminal size={18} className="shrink-0" />}
          <span>{!hasIpc ? '网关需在桌面应用中使用' : !canReadStatus ? '请重启桌面应用以加载网关' : loadingStatus ? '正在读取网关状态…' : '尚未读取网关状态'}</span>
        </div>
      )}
      {gatewayStatus && <>
        <PreferenceSection id="gateway-upstreams" title="上游服务" action={<span className="text-my-xs text-my-tertiary">{upstreams.filter((upstream) => upstream.status === 'connected').length} / {upstreams.length} 已连接</span>}>
          {[
            { id: 'local-kb', label: '本地知识库', hint: root ? `${root}/.trellis` : '未打开项目' },
            { id: 'weknora', label: 'WeKnora 知识库', hint: knowledge.context ? `${knowledge.context.scope.connectionName || '未绑定'} · ${knowledge.context.scope.collectionIds.length} 个知识库` : knowledge.loading ? '正在读取项目绑定' : knowledge.error ? '项目绑定读取失败' : root ? '绑定状态未知' : '未打开项目' },
            { id: 'trellis', label: 'Trellis 项目', hint: `${snapshot?.spec?.length || 0} 份规范 · ${snapshot?.tasks?.length || 0} 个活跃任务` }
          ].map((service) => {
            const upstream = upstreams.find((item) => item.id === service.id)
            const connected = upstream?.status === 'connected'
            const status = !root ? '未打开项目' : !upstream ? '状态未知' : upstream.status === 'connected' ? '已连接' : upstream.status === 'disabled' ? '已禁用' : upstream.status === 'error' ? '连接异常' : '未连接'
            return <PreferenceRow key={service.id} label={service.label} hint={service.hint} detail={(upstream?.endpoint || upstream?.error || upstream?.lastChecked || service.id === 'weknora') && <details className="text-my-xs text-my-tertiary">
                <summary className="cursor-pointer" aria-label={`${service.label}的连接详情`}>连接详情</summary>
                <div className="mt-2 space-y-1 break-words">
                  {upstream?.endpoint && <p className="font-mono break-all">{upstream.endpoint}</p>}
                  {upstream?.lastChecked && <p>状态更新时间：{relTime(upstream.lastChecked)}</p>}
                  {upstream?.error && <p className="text-my-danger-text whitespace-pre-wrap">{upstream.error}</p>}
                  {service.id === 'weknora' && <>
                    <p>{knowledge.loading ? '正在读取项目绑定' : knowledge.error ? '项目绑定读取失败' : knowledge.context?.scope.status === 'ok' ? '项目已绑定（未证明工具可用）' : knowledge.context ? knowledgeStatusLabel[knowledge.context.scope.status] : '项目绑定状态未知'}</p>
                    {knowledge.error && <p className="text-my-danger-text whitespace-pre-wrap">{knowledge.error}</p>}
                    <Button variant="outline" size="sm" onClick={() => void knowledge.refresh()} disabled={!root || knowledge.loading}>重新读取绑定</Button>
                  </>}
                </div>
              </details>}>
              <span className={clsx('my-chip', connected && root ? 'bg-my-success-subtle text-my-success-text' : upstream?.status === 'error' ? 'bg-my-warning-subtle text-my-warning-text' : 'bg-my-layer-3 text-my-tertiary')}>{status}</span>
              <span className="text-my-xs text-my-tertiary">{tools.filter((tool) => tool.upstreamId === service.id).length} 个工具</span>
              <Button
                variant="outline" size="sm"
                onClick={() => handleTestUpstream(service.id)}
                disabled={!canTestUpstream || (service.id === 'weknora' ? knowledge.context?.scope.status !== 'ok' : !upstream?.enabled)}
              >
                {testingUpstreamId === service.id ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
                {testingUpstreamId === service.id ? '探测中' : '探测'}
              </Button>
              {service.id === 'weknora' && <Button variant="ghost" size="sm" onClick={() => setPage('integrations')}>配置</Button>}

            </PreferenceRow>
          })}
        </PreferenceSection>

        <PreferenceSection id="gateway-tools" title="工具" action={<span className="text-my-xs text-my-tertiary">{filteredTools.length} 个工具</span>}>
          <PreferenceRow label="分类">
            <div className="my-segmented preference-choices" role="group" aria-label="工具分类">
              {([
                ['all', `全部 (${tools.length})`],
                ['knowledge', `知识库 (${tools.filter((tool) => tool.upstreamId === 'local-kb' || tool.upstreamId === 'weknora').length})`],
                ['project', `项目 (${tools.filter((tool) => tool.upstreamId === 'trellis').length})`]
              ] as const).map(([category, label]) => <button key={category} type="button" aria-pressed={categoryFilter === category} onClick={() => setCategoryFilter(category)} className="my-segment">{label}</button>)}
            </div>
          </PreferenceRow>
          {filteredTools.length === 0 && <div className="py-4 text-my-sm text-my-tertiary">当前分类没有工具</div>}
          {filteredTools.map((tool) => <div key={tool.name} className="preference-row">
            <div className="preference-row-label space-y-2">
              <details className="text-my-xs font-normal text-my-secondary">
                <summary className="cursor-pointer break-all font-mono text-my-sm text-my-primary">{tool.name}</summary>
                <div className="mt-3 space-y-3">
                  <p className="leading-relaxed">{tool.description}</p>
                  {Object.keys(tool.parameters).length === 0 ? <p className="text-my-tertiary">无参数</p> : <dl className="space-y-2">
                    {Object.entries(tool.parameters).map(([name, parameter]) => <div key={name}>
                      <dt className="break-all font-mono">{name}: {parameter.type}{parameter.required && <span className="ml-1 text-my-danger-text">必填</span>}</dt>
                      <dd className="mt-1 text-my-tertiary">{parameter.description}</dd>
                      {parameter.default !== undefined && <dd className="mt-1 break-all font-mono text-my-tertiary">默认值：{JSON.stringify(parameter.default)}</dd>}
                    </div>)}
                  </dl>}
                </div>
              </details>
              <div className="flex flex-wrap items-center gap-2 text-my-xs text-my-tertiary">
                <span>{tool.upstreamId}</span>
                {tool.securityRule && <span className="text-my-warning-text">{tool.securityRule}</span>}
              </div>
            </div>
            <div className="preference-row-control">
              <Button variant="outline" size="sm" onClick={() => handleOpenDebugger(tool)} disabled={!root || !actionsAvailable || !gatewayStatus.running || typeof api?.gatewayTestTool !== 'function'}>
                <Play size={12} />
                {root ? '在线调试' : '打开项目后调试'}
              </Button>
            </div>
          </div>)}
        </PreferenceSection>

        <PreferenceSection id="gateway-audit" title="调用记录" action={<div className="flex items-center gap-2">
          <span className="text-my-xs text-my-tertiary">累计 {gatewayStatus.totalQueries} 次调用</span>
          <Button variant="ghost" size="sm" onClick={loadStatus} disabled={!canReadStatus || loadingStatus} aria-label="刷新调用记录"><RefreshCw size={12} className={clsx(loadingStatus && 'animate-spin')} /></Button>
        </div>}>
          {recentLogs.length === 0 ? <p className="py-4 text-my-sm text-my-tertiary">暂无调用记录</p> : <div className="divide-y divide-my-line">
            {recentLogs.map((log) => <div key={log.id} className="py-4 text-my-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className={clsx('my-chip', log.status === 'success' && 'bg-my-success-subtle text-my-success-text', log.status === 'blocked' && 'bg-my-danger-subtle text-my-danger-text', log.status === 'error' && 'bg-my-warning-subtle text-my-warning-text')}>{log.status === 'success' ? '成功' : log.status === 'blocked' ? '已拦截' : '失败'}</span>
                  <span className="break-all font-mono text-my-primary">{log.toolName || log.query || 'mcp_call'}</span>
                </div>
                <div className="flex items-center gap-2 text-my-tertiary"><span className="font-mono">{log.elapsedMs}ms</span><span>{relTime(log.timestamp)}</span></div>
              </div>
              {log.error && <p className="mt-2 break-words text-my-danger-text">{log.error}</p>}
              <details className="mt-2 text-my-tertiary">
                <summary className="cursor-pointer">调用详情</summary>
                <div className="mt-2 space-y-2">
                  <p>上游：{log.upstreamId || 'gateway'}</p>
                  {log.input && Object.keys(log.input).length > 0 && <pre className="whitespace-pre-wrap break-all font-mono">入参：{JSON.stringify(log.input, null, 2)}</pre>}
                  {log.responsePreview && <pre className="whitespace-pre-wrap break-all font-mono">响应：{log.responsePreview}</pre>}
                </div>
              </details>
            </div>)}
          </div>}
        </PreferenceSection>
      </>}

      {/* 模态框 1: 在线调试器 (Tool Debugger Drawer/Modal) */}
      {selectedTool && (
        <Modal open onClose={closeDebugger} ariaLabel={`在线工具调试: ${selectedTool.name}`} width="42rem" placement="center">
          <div className="flex max-h-[inherit] flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-my-line px-5 py-3">
              <div className="flex items-center gap-2">
                <Play size={16} className="text-my-accent-text" />
                <h3 className="text-my-sm font-semibold text-my-primary">
                  在线工具调试: <span className="font-mono text-my-accent-text">{selectedTool.name}</span>
                </h3>
              </div>
              <Button variant="ghost" size="sm" className="my-icon-control shrink-0" aria-label="关闭调试器" onClick={closeDebugger}>
                <X size={14} />
              </Button>
            </div>

            <div className="my-scrollbar min-h-0 overflow-y-auto p-5 space-y-4" style={{ scrollbarGutter: 'stable' }}>
              <p className="text-my-xs text-my-secondary leading-relaxed">{selectedTool.description}</p>
              {selectedTool.securityRule && <p className="text-my-xs text-my-warning-text">{selectedTool.securityRule}</p>}

              {/* 参数输入 */}
              <div className="space-y-3">
                <h4 className="text-my-xs font-semibold text-my-primary">调用参数</h4>
                {Object.keys(selectedTool.parameters).length === 0 ? (
                  <div className="rounded-my-lg border border-my-line bg-my-canvas p-3 text-my-xs text-my-tertiary">
                    该工具为无参工具，直接点击下方“执行调用”即可。
                  </div>
                ) : (
                  Object.entries(selectedTool.parameters).map(([pName, pMeta]) => (
                    <div key={pName} className="space-y-1">
                      <label htmlFor={`gateway-tool-${pName}`} className="flex items-center justify-between text-my-xs font-medium text-my-secondary">
                        <span>
                          {pName} ({pMeta.type})
                          {pMeta.required && <span className="text-my-danger-text ml-1">*</span>}
                        </span>
                        <span className="text-my-xs text-my-tertiary">{pMeta.description}</span>
                      </label>
                      {pName === 'sql' ? (
                        <textarea
                          id={`gateway-tool-${pName}`}
                          rows={3}
                          disabled={executingTool}
                          value={toolArgs[pName] || ''}
                          onChange={(e) => setToolArgs({ ...toolArgs, [pName]: e.target.value })}
                          className="w-full rounded-my-md border border-my-line bg-my-surface-1 p-2.5 font-mono text-my-xs text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent"
                          placeholder="输入 SQL 语句，例如 SELECT * FROM t_order LIMIT 5"
                        />
                      ) : (
                        <input
                          id={`gateway-tool-${pName}`}
                          type="text"
                          disabled={executingTool}
                          value={toolArgs[pName] || ''}
                          onChange={(e) => setToolArgs({ ...toolArgs, [pName]: e.target.value })}
                          className="my-input font-mono text-my-sm"
                          placeholder={`输入 ${pName}`}
                        />
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* 快捷测试按钮提示 */}
              {selectedTool.name === 'kb_search' && (
                <div className="flex items-center gap-2 text-my-xs text-my-tertiary">
                  <span>快捷填入:</span>
                  <button
                    disabled={executingTool}
                    onClick={() => setToolArgs({ query: '项目规范', library: 'spec' })}
                    className="underline hover:text-my-secondary"
                  >
                    检索规范库
                  </button>
                  <span>·</span>
                  <button
                    disabled={executingTool}
                    onClick={() => setToolArgs({ query: '归档任务', library: 'archive' })}
                    className="underline hover:text-my-secondary"
                  >
                    检索归档库
                  </button>
                </div>
              )}

              {/* 调试执行结果 */}
              {executionError && <div role="alert" className="rounded-my-lg border border-my-line p-3 text-my-xs text-my-danger-text"><span>执行失败，可重试调用</span><details className="mt-1"><summary className="cursor-pointer">错误详情</summary><p className="whitespace-pre-wrap break-words">{executionError}</p></details></div>}
              {testResult && (
                <div role={testResult.ok ? 'status' : 'alert'} className="space-y-2 border-t border-my-line pt-3">
                  <div className="flex items-center justify-between">
                    <span className="text-my-xs font-semibold text-my-primary">执行结果</span>
                    <span className="font-mono text-my-xs text-my-success-text">
                      耗时: {testResult.elapsedMs}ms
                    </span>
                  </div>
                  {testResult.blockedBySecurity ? (
                    <div className="rounded-my-lg border border-my-line-danger bg-my-danger-subtle p-3 text-my-xs text-my-danger-text space-y-1">
                      <div className="flex items-center gap-1.5 font-semibold">
                        <AlertTriangle size={14} />
                        <span>网关安全防线触发：执行被拦截！</span>
                      </div>
                      <p>{testResult.error}</p>
                    </div>
                  ) : testResult.ok ? (
                    <pre className="max-h-60 overflow-y-auto rounded-my-lg border border-my-line bg-my-canvas p-3 font-mono text-my-xs text-my-secondary leading-relaxed">
                      {JSON.stringify(testResult.result, null, 2)}
                    </pre>
                  ) : (
                    <div className="rounded-my-lg border border-my-line-warning bg-my-warning-subtle p-3 text-my-xs text-my-warning-text">
                      {testResult.error}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex shrink-0 justify-end gap-2 border-t border-my-line px-5 py-3">
              <Button variant="ghost" onClick={closeDebugger}>
                关闭
              </Button>
              <Button variant="primary" onClick={handleExecuteTool} disabled={executingTool || !actionsAvailable}>
                {executingTool ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                <span>{executingTool ? '正在执行' : executionError || testResult && !testResult.ok ? '重试调用' : '执行调用'}</span>
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* 模态框 2: 网关安全策略设置 (Security Guardrails Modal) */}
      {showSecurityModal && (
        <Modal open onClose={closeSecurity} ariaLabel="网关安全防线与熔断策略" width="28rem" placement="center">
          <div className="flex max-h-[inherit] flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-my-line px-5 py-3">
              <div className="flex items-center gap-2">
                <ShieldCheck size={16} className="text-my-success-text" />
                <h3 className="text-my-sm font-semibold text-my-primary">网关安全防线与熔断策略</h3>
              </div>
              <Button variant="ghost" size="sm" className="my-icon-control shrink-0" aria-label="关闭安全策略" onClick={closeSecurity}>
                <X size={14} />
              </Button>
            </div>

            <div className="my-scrollbar min-h-0 overflow-y-auto p-5 space-y-4 text-my-xs" style={{ scrollbarGutter: 'stable' }}>
              {securityError && <div role="alert" className="rounded-my-lg border border-my-line p-3 text-my-danger-text">{securityError}</div>}
              <div className="flex items-center justify-between rounded-my-lg border border-my-line bg-my-canvas p-3">
                <div>
                  <div className="font-semibold text-my-primary">SQL 只读安全拦截</div>
                  <p className="mt-0.5 text-my-tertiary">强制阻断 DROP / DELETE / UPDATE / ALTER 等写操作</p>
                </div>
                <fieldset disabled={savingSecurity} className="border-0 p-0">
                  <label><span className="sr-only">SQL 只读安全拦截</span><Checkbox
                    checked={securityForm.sqlReadOnly}
                    onChange={(v) => setSecurityForm({ ...securityForm, sqlReadOnly: v })}
                  /></label>
                </fieldset>
              </div>

              <div className="space-y-1">
                <label htmlFor="gateway-timeout" className="font-semibold text-my-primary">上游调用硬超时熔断 (毫秒)</label>
                <input
                  id="gateway-timeout"
                  type="number"
                  disabled={savingSecurity}
                  value={securityForm.timeoutMs}
                  onChange={(e) => setSecurityForm({ ...securityForm, timeoutMs: Number(e.target.value) || 2000 })}
                  className="my-input"
                />
                <p className="text-my-xs text-my-tertiary">超过设定时间立即熔断返回，防止外部服务慢拖垮 AI 编辑器</p>
              </div>

              <div className="space-y-1">
                <label htmlFor="gateway-response-limit" className="font-semibold text-my-primary">最大响应字符截断限制</label>
                <input
                  id="gateway-response-limit"
                  type="number"
                  disabled={savingSecurity}
                  value={securityForm.maxResponseChars}
                  onChange={(e) => setSecurityForm({ ...securityForm, maxResponseChars: Number(e.target.value) || 12000 })}
                  className="my-input"
                />
                <p className="text-my-xs text-my-tertiary">限制单次工具返回的最大字符数，防止超大表查询撑爆模型上下文</p>
              </div>
            </div>

            <div className="flex shrink-0 justify-end gap-2 border-t border-my-line px-5 py-3">
              <Button variant="ghost" onClick={closeSecurity}>
                取消
              </Button>
              <Button variant="primary" onClick={handleSaveSecurity} disabled={savingSecurity || !actionsAvailable}>
                {savingSecurity ? '正在保存' : securityError ? '重试保存' : '保存策略'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* 模态框 3: 接入 AI 编辑器 (Mount Config Modal) */}
      {showMountModal && mcpInstallResult && (
        <Modal open onClose={() => setShowMountModal(false)} ariaLabel="接入 AI 编程编辑器" width="36rem" placement="center">
          <div className="flex max-h-[inherit] flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-my-line px-5 py-3">
              <div className="flex items-center gap-2">
                <Terminal size={16} className="text-my-accent-text" />
                <h3 className="text-my-sm font-semibold text-my-primary">接入 AI 编程编辑器</h3>
              </div>
              <Button variant="ghost" size="sm" className="my-icon-control shrink-0" aria-label="关闭接入配置" onClick={() => setShowMountModal(false)}>
                <X size={14} />
              </Button>
            </div>

            <div className="my-scrollbar min-h-0 overflow-y-auto p-5 space-y-4 text-my-xs" style={{ scrollbarGutter: 'stable' }}>
              <div className="rounded-my-lg border border-my-line-success bg-my-success-subtle p-3 text-my-success-text leading-relaxed">
                网关脚本已就绪：<br />
                <code className="font-mono text-my-xs break-all">{mcpInstallResult.scriptPath}</code>
              </div>

              {/* Claude Code */}
              <div className="rounded-my-lg border border-my-line bg-my-canvas p-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-my-primary">Claude Code (.mcp.json)</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={copyFeedback.status === 'copying'}
                    onClick={() =>
                      copySnippet(
                        'claude',
                        JSON.stringify(
                          {
                            mcpServers: {
                              'trellis-gateway': {
                                command: 'node',
                                args: [mcpInstallResult.scriptPath, '--root', snapshot?.meta.root || '.']
                              }
                            }
                          },
                          null,
                          2
                        )
                      )
                    }
                  >
                    {copiedKey === 'claude' && copyFeedback.status === 'copied' ? <Check size={12} className="text-my-success-text" /> : <Copy size={12} />}
                    <span>{copiedKey === 'claude' && copyFeedback.status === 'copied' ? '已复制' : copiedKey === 'claude' && copyFeedback.status === 'copying' ? '复制中' : '复制 JSON'}</span>
                  </Button>
                </div>
                <pre className="mt-2 overflow-x-auto rounded-my-sm border border-my-line bg-my-canvas p-2 font-mono text-my-xs text-my-secondary">
{`{
  "mcpServers": {
    "trellis-gateway": {
      "command": "node",
      "args": ["${mcpInstallResult.scriptPath}", "--root", "${snapshot?.meta.root || '.'}"]
    }
  }
}`}
                </pre>
              </div>

              {/* Codex */}
              <div className="rounded-my-lg border border-my-line bg-my-canvas p-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-my-primary">Codex (~/.codex/config.toml)</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={copyFeedback.status === 'copying'}
                    onClick={() =>
                      copySnippet(
                        'codex',
                        `[mcp_servers.trellis-gateway]\ncommand = "node"\nargs = ["${mcpInstallResult.scriptPath}", "--root", "${snapshot?.meta.root || '.'}"]`
                      )
                    }
                  >
                    {copiedKey === 'codex' && copyFeedback.status === 'copied' ? <Check size={12} className="text-my-success-text" /> : <Copy size={12} />}
                    <span>{copiedKey === 'codex' && copyFeedback.status === 'copied' ? '已复制' : copiedKey === 'codex' && copyFeedback.status === 'copying' ? '复制中' : '复制 TOML'}</span>
                  </Button>
                </div>
                <pre className="mt-2 overflow-x-auto rounded-my-sm border border-my-line bg-my-canvas p-2 font-mono text-my-xs text-my-secondary">
{`[mcp_servers.trellis-gateway]
command = "node"
args = ["${mcpInstallResult.scriptPath}", "--root", "${snapshot?.meta.root || '.'}"]`}
                </pre>
              </div>
            </div>

            {copyFeedback.status === 'error' && <p role="alert" className="px-5 pb-3 text-my-xs text-my-danger-text">复制失败，请重试或选中文本复制。</p>}
            <div className="flex shrink-0 justify-end border-t border-my-line px-5 py-3">
              <Button variant="primary" onClick={() => setShowMountModal(false)}>
                完成
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
