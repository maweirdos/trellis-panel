import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Database,
  Cloud,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  RefreshCw,
  Terminal,
  Activity,
  Layers,
  Copy,
  Check,
  PlusCircle,
  Loader2,
  X,
  ShieldCheck,
  Play,
  Code,
  FileCode
} from 'lucide-react'
import { useApp } from '../store'
import { api, hasIpc } from '../api'
import { clsx } from 'clsx'
import { Button, Checkbox, Modal } from '../my/ui'
import { relTime } from '../utils/format'
import { errorMessage } from '../../../shared/errors'
import { useProjectKnowledge } from '../knowledge/bridge'
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

  const upstreams = gatewayStatus?.upstreams || []
  const tools = gatewayStatus?.tools || []
  const filteredTools = tools.filter((t) => {
    if (categoryFilter === 'all') return true
    if (categoryFilter === 'knowledge') return t.upstreamId === 'local-kb' || t.upstreamId === 'weknora'
    if (categoryFilter === 'project') return t.upstreamId === 'trellis'
    return true
  })

  const recentLogs = gatewayStatus?.recentLogs || []

  return (
    <div className="min-w-0">
      <div className="space-y-6">
        {/* 状态徽标与操作栏 */}
        <div className="flex flex-col gap-3 border-b border-my-line pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <span className={clsx('my-chip', gatewayStatus?.running && !statusError && !loadingStatus ? 'bg-my-success-subtle text-my-success-text' : 'bg-my-layer-3 text-my-tertiary')}>
              {loadingStatus ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
              {!hasIpc ? '桌面功能不可用' : statusError ? '状态待确认' : loadingStatus ? '正在读取状态' : gatewayStatus ? `${gatewayStatus.running ? '运行中' : '已停止'} · ${gatewayStatus.transport}` : '状态未知'}
            </span>
            {hasIpc && !root && <span className="my-chip bg-my-layer-3 text-my-tertiary">未打开项目</span>}
            {gatewayStatus && <span className="my-chip bg-my-accent-subtle text-my-accent-text">
              {tools.length} 个聚合工具
            </span>}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setShowSecurityModal(true)}
              disabled={!actionsAvailable || savingSecurity && !showSecurityModal || installingMcp || typeof api?.gatewayUpdateSecurity !== 'function'}
              title="配置安全防护与熔断参数"
            >
              <ShieldCheck size={13} className="text-my-success-text" />
              <span>安全策略</span>
            </Button>
            <Button variant="outline" onClick={loadStatus} disabled={!canReadStatus || loadingStatus} title="刷新网关状态">
              <RefreshCw size={12} className={clsx(loadingStatus && 'animate-spin')} />
              <span>刷新</span>
            </Button>
            <Button variant="primary" onClick={handleOpenMountModal} disabled={!root || !actionsAvailable || installingMcp || typeof api?.kbMcpInstall !== 'function'}>
              {installingMcp ? <Loader2 size={12} className="animate-spin" /> : <Terminal size={12} />}
              <span>{installingMcp ? '正在生成配置' : '接入 AI 编辑器'}</span>
            </Button>
          </div>
        </div>

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
        {/* 1. 上游服务治理 (Upstream Services) */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-my-xs font-semibold uppercase tracking-wider text-my-tertiary">
              <Layers className="h-4 w-4" />
              <span>上游服务治理 (Upstream Services)</span>
            </h2>
            <span className="text-my-xs text-my-tertiary">
              共接入 {upstreams.filter((u) => u.status === 'connected').length} / {upstreams.length} 个上游服务
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {/* 1. 本地知识库（四库） */}
            <div className="flex flex-col justify-between rounded-my-lg border border-my-line bg-my-layer-2 p-4">
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4 text-my-info-text" />
                    <h3 className="text-my-xs font-semibold text-my-primary">本地知识库</h3>
                  </div>
                  {upstreams.find((u) => u.id === 'local-kb')?.status === 'connected' ? (
                    <span className="my-chip bg-my-success-subtle text-my-success-text">
                      <CheckCircle2 className="h-3 w-3" />
                      已连接
                    </span>
                  ) : (
                    <span className="my-chip bg-my-layer-3 text-my-tertiary">
                      <AlertCircle className="h-3 w-3" />
                      {root ? '未连接' : '未打开项目'}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-my-xs leading-relaxed text-my-tertiary">
                  需求库 / 规范库 / Wiki 库 / 归档库的毫秒级全文检索，供对话与 AI 规划查证项目事实。
                </p>
                <div className="mt-3 space-y-1 font-mono text-my-xs text-my-tertiary">
                  <div className="truncate">端点: {snapshot?.meta?.root ? `${snapshot.meta.root}/.trellis` : '—'}</div>
                  <div className={root ? 'text-my-success-text' : 'text-my-tertiary'}>{root ? '进程内倒排索引 · 离线可用' : '打开项目后使用本地知识库'}</div>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-my-line pt-3">
                <button
                  onClick={() => handleTestUpstream('local-kb')}
                  disabled={!canTestUpstream || !upstreams.find((u) => u.id === 'local-kb')?.enabled}
                  className="my-control my-control-sm text-my-info-text hover:text-[var(--my-txt-info-secondary)] disabled:opacity-40"
                >
                  {testingUpstreamId === 'local-kb' ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Activity size={12} />
                  )}
                  <span>连通性探测</span>
                </button>
                <span className="text-my-xs text-my-tertiary">{tools.filter((t) => t.upstreamId === 'local-kb').length} 个工具</span>
              </div>
            </div>

            {/* 2. WeKnora 企业知识库 MCP */}
            <div className="flex flex-col justify-between rounded-my-lg border border-my-line bg-my-layer-2 p-4">
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cloud className="h-4 w-4 text-my-info-text" />
                    <h3 className="text-my-xs font-semibold text-my-primary">WeKnora 知识库</h3>
                  </div>
                  {knowledge.context?.scope.status === 'ok' ? (
                    <span className="my-chip bg-my-success-subtle text-my-success-text">
                      <CheckCircle2 className="h-3 w-3" />
                      项目已绑定（未证明工具可用）
                    </span>
                  ) : (
                    <span className="my-chip bg-my-layer-3 text-my-tertiary">
                      <AlertCircle className="h-3 w-3" />
                      项目知识不可用
                    </span>
                  )}
                </div>
                <p className="mt-2 text-my-xs leading-relaxed text-my-tertiary">
                  企业级 RAG 知识平台，提供业务规则文档、技术架构标准与跨团队规范向量检索。
                </p>
                <div className="mt-3 space-y-1 font-mono text-my-xs text-my-tertiary">
                  <div className="truncate">连接: {knowledge.context?.scope.connectionName || '未绑定'}</div>
                  <div>项目范围: {knowledge.context?.scope.collectionIds.length || 0} 个知识库</div>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-my-line pt-3">
                <button
                  onClick={() => handleTestUpstream('weknora')}
                  disabled={!canTestUpstream || knowledge.context?.scope.status !== 'ok'}
                  className="my-control my-control-sm text-my-info-text hover:text-[var(--my-txt-info-secondary)] disabled:opacity-40"
                >
                  {testingUpstreamId === 'weknora' ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Activity size={12} />
                  )}
                  <span>连通性探测</span>
                </button>
                <button
                  onClick={() => setPage('integrations')}
                  className="text-my-xs text-my-tertiary hover:text-my-primary"
                >
                  配置 →
                </button>
              </div>
            </div>

            {/* 3. Trellis 项目内核 MCP */}
            <div className="flex flex-col justify-between rounded-my-lg border border-my-line bg-my-layer-2 p-4">
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileCode className="h-4 w-4 text-my-success-text" />
                    <h3 className="text-my-xs font-semibold text-my-primary">Trellis 项目内核</h3>
                  </div>
                  <span className={clsx('my-chip', upstreams.find((u) => u.id === 'trellis')?.status === 'connected' ? 'bg-my-success-subtle text-my-success-text' : 'bg-my-layer-3 text-my-tertiary')}>
                    {upstreams.find((u) => u.id === 'trellis')?.status === 'connected' ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                    {upstreams.find((u) => u.id === 'trellis')?.status === 'connected' ? '已挂载' : root ? '未挂载' : '未打开项目'}
                  </span>
                </div>
                <p className="mt-2 text-my-xs leading-relaxed text-my-tertiary">
                  动态注入本地规范文档（.trellis/spec/）与当前活跃任务的 PRD / 设计上下文。
                </p>
                <div className="mt-3 space-y-1 font-mono text-my-xs text-my-tertiary">
                  <div className="truncate">规范: {snapshot?.spec?.length || 0} 份文档</div>
                  <div>活跃任务: {snapshot?.tasks?.length || 0} 个</div>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-my-line pt-3">
                <button
                  onClick={() => handleTestUpstream('trellis')}
                  disabled={!canTestUpstream || !upstreams.find((u) => u.id === 'trellis')?.enabled}
                  className="my-control my-control-sm text-my-success-text hover:text-[var(--my-txt-success-secondary)] disabled:opacity-40"
                >
                  <Activity size={12} />
                  <span>状态探测</span>
                </button>
                <span className="text-my-xs text-my-tertiary">{tools.filter((t) => t.upstreamId === 'trellis').length} 个工具</span>
              </div>
            </div>

            {/* 4. 自定义 MCP 扩展 */}
            <div className="flex flex-col justify-between rounded-my-lg border border-dashed border-my-line bg-my-layer-1 p-4">
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <PlusCircle className="h-4 w-4 text-my-label-purple-icon" />
                    <h3 className="text-my-xs font-semibold text-my-primary">自定义扩展槽位</h3>
                  </div>
                  <span className="my-chip bg-my-label-purple text-my-label-purple-text">
                    可插拔
                  </span>
                </div>
                <p className="mt-2 text-my-xs leading-relaxed text-my-tertiary">
                  通过 stdio 或 SSE 聚合第三方 MCP 命令行服务（例如 git-mcp, jira-mcp）。
                </p>
              </div>
              <div className="mt-4 border-t border-my-line pt-3 text-my-xs text-my-tertiary">
                待挂载第三方服务
              </div>
            </div>
          </div>
        </div>

        {/* 2. 聚合工具注册表与在线调试器 (Tool Catalog & Debugger) */}
        <div className="rounded-my-lg border border-my-line bg-my-layer-2 p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-my-line pb-4">
            <div>
              <div className="flex items-center gap-2">
                <Code className="h-4 w-4 text-my-accent-text" />
                <h2 className="text-my-xs font-semibold text-my-primary">聚合工具目录 (Tool Catalog)</h2>
                <span className="my-chip border border-my-line bg-my-canvas font-mono text-my-tertiary">
                  {filteredTools.length} 个工具
                </span>
              </div>
              <p className="mt-0.5 text-my-xs text-my-tertiary">
                网关统一暴露给 AI 编辑器的标准工具。点击工具右侧的“在线调试”可直接在面板输入参数实测执行。
              </p>
            </div>

            {/* 分类过滤器 */}
            <div className="flex items-center rounded-my-md bg-my-canvas p-0.5 border border-my-line text-my-xs">
              <button
                onClick={() => setCategoryFilter('all')}
                className={clsx(
                  'rounded-my-sm px-2.5 py-1 transition-colors',
                  categoryFilter === 'all' ? 'bg-my-layer-1-active font-medium text-my-primary' : 'text-my-tertiary hover:text-my-primary'
                )}
              >
                全部 ({tools.length})
              </button>
              <button
                onClick={() => setCategoryFilter('knowledge')}
                className={clsx(
                  'rounded-my-sm px-2.5 py-1 transition-colors',
                  categoryFilter === 'knowledge' ? 'bg-my-layer-1-active font-medium text-my-primary' : 'text-my-tertiary hover:text-my-primary'
                )}
              >
                知识库 ({tools.filter((t) => t.upstreamId === 'local-kb' || t.upstreamId === 'weknora').length})
              </button>
              <button
                onClick={() => setCategoryFilter('project')}
                className={clsx(
                  'rounded-my-sm px-2.5 py-1 transition-colors',
                  categoryFilter === 'project' ? 'bg-my-layer-1-active font-medium text-my-primary' : 'text-my-tertiary hover:text-my-primary'
                )}
              >
                项目内核 ({tools.filter((t) => t.upstreamId === 'trellis').length})
              </button>
            </div>
          </div>

          {/* 工具列表 */}
          <div className="mt-4 divide-y divide-my-line">
            {filteredTools.length === 0 && <div className="py-4 text-my-xs text-my-tertiary">当前分类没有工具</div>}
            {filteredTools.map((tool) => (
              <div
                key={tool.name}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between first:pt-0 last:pb-0"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-my-xs font-semibold text-my-accent-text">
                      {tool.name}
                    </span>
                    <span className="my-chip border border-my-line bg-my-canvas font-mono uppercase text-my-tertiary">
                      {tool.upstreamId}
                    </span>
                    {tool.securityRule && (
                      <span className="my-chip bg-my-warning-subtle text-my-warning-text">
                        {tool.securityRule}
                      </span>
                    )}
                  </div>
                  <p className="text-my-xs text-my-tertiary leading-relaxed">{tool.description}</p>
                  <div className="flex items-center gap-2 font-mono text-my-xs text-my-tertiary">
                    <span>参数:</span>
                    {Object.keys(tool.parameters).length === 0 ? (
                      <span>无参</span>
                    ) : (
                      Object.entries(tool.parameters).map(([pName, pMeta]) => (
                        <span key={pName} className="rounded-my-sm border border-my-line bg-my-canvas px-1 text-my-secondary">
                          {pName}: {pMeta.type}
                          {pMeta.required && <span className="text-my-danger-text">*</span>}
                        </span>
                      ))
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 sm:self-center">
                  <button
                    onClick={() => handleOpenDebugger(tool)}
                    disabled={!root || !actionsAvailable || !gatewayStatus.running || typeof api?.gatewayTestTool !== 'function'}
                    className="my-control border border-my-line bg-my-canvas text-my-secondary hover:border-my-line-accent-subtle hover:text-my-accent-text"
                  >
                    <Play size={11} className="text-my-accent-text" />
                    <span>{root ? '在线调试' : '打开项目后调试'}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 3. 实时调用审计流水 (Invocation & Traffic Audit) */}
        <div className="rounded-my-lg border border-my-line bg-my-layer-2 p-5">
          <div className="flex items-center justify-between border-b border-my-line pb-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-my-accent-text" />
              <h2 className="text-my-xs font-semibold text-my-primary">实时调用审计流水 (Invocation Audit)</h2>
              <span className="my-chip border border-my-line bg-my-canvas font-mono text-my-tertiary">
                累计 {gatewayStatus?.totalQueries || 0} 次调用
              </span>
            </div>
            <Button variant="ghost" size="sm" onClick={loadStatus} disabled={!canReadStatus || loadingStatus} title="刷新流水" aria-label="刷新流水">
              <RefreshCw size={12} className={clsx(loadingStatus && 'animate-spin')} />
            </Button>
          </div>

          <div className="mt-3 divide-y divide-my-line">
            {recentLogs.length === 0 ? (
              <div className="py-8 text-center text-my-xs text-my-tertiary">
                暂无调用记录。当 AI 编辑器调用网关工具或通过上方“在线调试”发起测试时，此处将实时展示调用入参、耗时与安全防护状态。
              </div>
            ) : (
              recentLogs.map((log) => (
                <div key={log.id} className="py-3 text-my-xs first:pt-1 last:pb-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={clsx(
                          'my-chip font-mono',
                          log.status === 'success' && 'bg-my-success-subtle text-my-success-text',
                          log.status === 'blocked' && 'bg-my-danger-subtle text-my-danger-text',
                          log.status === 'error' && 'bg-my-warning-subtle text-my-warning-text'
                        )}
                      >
                        {log.status === 'success' ? '200 OK' : log.status === 'blocked' ? '403 BLOCKED' : '500 ERROR'}
                      </span>
                      <span className="font-mono font-semibold text-my-primary">
                        {log.toolName || log.query || 'mcp_call'}
                      </span>
                      <span className="text-my-xs text-my-tertiary font-mono">[{log.upstreamId || 'gateway'}]</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-my-xs text-my-success-text">
                        {log.elapsedMs}ms
                      </span>
                      <span className="text-my-xs text-my-tertiary">{relTime(log.timestamp)}</span>
                    </div>
                  </div>

                  {/* 详细入参与拦截/响应预览 */}
                  <div className="mt-1.5 space-y-1 text-my-xs">
                    {log.input && Object.keys(log.input).length > 0 && (
                      <div className="font-mono text-my-tertiary">
                        入参: <code className="text-my-secondary">{JSON.stringify(log.input)}</code>
                      </div>
                    )}
                    {log.error && (
                      <div className="text-my-danger-text font-mono">
                        {log.error}
                      </div>
                    )}
                    {log.responsePreview && (
                      <div className="text-my-tertiary font-mono truncate max-w-4xl">
                        响应: {log.responsePreview}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        </>}
      </div>

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

              {/* 参数输入 */}
              <div className="space-y-3">
                <h4 className="text-my-xs font-semibold text-my-primary">调用入参 (Parameters)</h4>
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
                <span>{executingTool ? '正在执行' : executionError || testResult && !testResult.ok ? '重试调用' : '执行调用 (Run)'}</span>
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
                  <div className="font-semibold text-my-primary">SQL 只读安全拦截 (Strict Read-Only)</div>
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
                <h3 className="text-my-sm font-semibold text-my-primary">接入 AI 编程编辑器 (MCP Client Config)</h3>
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
