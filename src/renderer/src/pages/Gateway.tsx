import { useCallback, useEffect, useState } from 'react'
import {
  BrainCircuit,
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
  Settings2,
  Code,
  FileCode,
  ArrowUpRight
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { relTime } from '../utils/format'
import { errorMessage } from '../../../shared/errors'
import type {
  GatewayLogEntry,
  GatewaySecurityConfig,
  GatewayStatus,
  GatewayTestToolResult,
  GatewayToolDef,
  GatewayUpstream,
  KbMcpInstallResult
} from '../../../shared/types'
import type { JSX } from 'react'

export function GatewayPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const settings = useApp((s) => s.settings)
  const pushToast = useApp((s) => s.pushToast)
  const setPage = useApp((s) => s.setPage)

  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [testingUpstreamId, setTestingUpstreamId] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  // 调试器状态
  const [selectedTool, setSelectedTool] = useState<GatewayToolDef | null>(null)
  const [toolArgs, setToolArgs] = useState<Record<string, string>>({})
  const [executingTool, setExecutingTool] = useState(false)
  const [testResult, setTestResult] = useState<GatewayTestToolResult | null>(null)

  // 过滤分类
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'knowledge' | 'project'>('all')

  // 接入弹窗 & 安全配置弹窗
  const [showMountModal, setShowMountModal] = useState(false)
  const [showSecurityModal, setShowSecurityModal] = useState(false)
  const [mcpInstallResult, setMcpInstallResult] = useState<KbMcpInstallResult | null>(null)
  const [installingMcp, setInstallingMcp] = useState(false)

  // 安全配置表单
  const [securityForm, setSecurityForm] = useState<GatewaySecurityConfig>({
    sqlReadOnly: true,
    timeoutMs: 2000,
    maxResponseChars: 12000
  })

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true)
    try {
      const res = await api.gatewayStatus()
      if (res && res.ok) {
        setGatewayStatus(res)
        if (res.security) {
          setSecurityForm(res.security)
        }
      }
    } catch (e) {
      console.error('Failed to load gateway status', e)
    } finally {
      setLoadingStatus(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  const handleTestUpstream = async (upstreamId: string) => {
    setTestingUpstreamId(upstreamId)
    try {
      const res = await api.gatewayTestProvider(upstreamId)
      if (res.ok) {
        pushToast({ kind: 'success', title: `上游服务 [${upstreamId}] 连通性测试通过！` })
      } else {
        pushToast({ kind: 'error', title: `测试失败: ${res.error || '未知错误'}` })
      }
      loadStatus()
    } catch (e) {
      pushToast({ kind: 'error', title: `测试失败: ${errorMessage(e) || String(e)}` })
    } finally {
      setTestingUpstreamId(null)
    }
  }

  const handleOpenDebugger = (tool: GatewayToolDef) => {
    setSelectedTool(tool)
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
    if (!selectedTool) return
    setExecutingTool(true)
    setTestResult(null)
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
      setTestResult(res)
      if (res.blockedBySecurity) {
        pushToast({ kind: 'warn', title: '网关安全防线拦截：禁止破坏性操作！' })
      } else if (res.ok) {
        pushToast({ kind: 'success', title: `工具 [${selectedTool.name}] 执行完成 (${res.elapsedMs}ms)` })
      } else {
        pushToast({ kind: 'error', title: `执行失败: ${res.error || '未知错误'}` })
      }
      loadStatus()
    } catch (e) {
      pushToast({ kind: 'error', title: `执行异常: ${errorMessage(e) || String(e)}` })
    } finally {
      setExecutingTool(false)
    }
  }

  const handleSaveSecurity = async () => {
    try {
      await api.gatewayUpdateSecurity(securityForm)
      pushToast({ kind: 'success', title: '网关安全策略已更新' })
      setShowSecurityModal(false)
      loadStatus()
    } catch (e) {
      pushToast({ kind: 'error', title: `更新失败: ${errorMessage(e) || String(e)}` })
    }
  }

  const handleOpenMountModal = async () => {
    setInstallingMcp(true)
    try {
      const res = await api.kbMcpInstall()
      setMcpInstallResult(res)
      setShowMountModal(true)
    } catch (e) {
      pushToast({ kind: 'error', title: `生成配置失败: ${errorMessage(e) || String(e)}` })
    } finally {
      setInstallingMcp(false)
    }
  }

  const copySnippet = (key: string, text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 2000)
    pushToast({ kind: 'info', title: '已复制到剪贴板' })
  }

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
    <div className="flex h-full min-w-0 flex-col overflow-y-auto bg-ink-900 p-6 text-mist-100 animate-fade-in">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* 顶部标题与网关中枢状态 */}
        <div className="flex flex-col gap-4 border-b border-ink-750 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <BrainCircuit className="h-5 w-5 text-leaf-soft" />
              <h1 className="text-base font-semibold text-mist-100">MCP 网关中枢</h1>
              <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400 flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Active · stdio
              </span>
              <span className="rounded-full bg-leaf-dim/20 px-2 py-0.5 text-xs font-medium text-leaf-soft">
                {tools.length} 个聚合工具
              </span>
            </div>
            <p className="mt-1 text-xs text-mist-400">
              聚合本地知识库（四库全文检索）、WeKnora 企业知识库与 Trellis 项目上下文，为 AI 对话与编程工具提供统一代理与安全防护防线。
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSecurityModal(true)}
              className="btn-ghost flex items-center gap-1 text-xs text-mist-300 hover:text-mist-100 border border-ink-700"
              title="配置安全防护与熔断参数"
            >
              <ShieldCheck size={13} className="text-emerald-500" />
              <span>安全策略</span>
            </button>
            <button
              onClick={loadStatus}
              disabled={loadingStatus}
              className="btn-ghost flex items-center gap-1 text-xs text-mist-300 hover:text-mist-100 border border-ink-700"
              title="刷新网关状态"
            >
              <RefreshCw size={12} className={clsx(loadingStatus && 'animate-spin')} />
              <span>刷新</span>
            </button>
            <button
              onClick={handleOpenMountModal}
              disabled={installingMcp}
              className="btn-primary flex items-center gap-1.5 text-xs"
            >
              <Terminal size={12} />
              <span>接入 AI 编辑器</span>
            </button>
          </div>
        </div>

        {/* 1. 上游服务治理 (Upstream Services) */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-mist-400">
              <Layers className="h-4 w-4" />
              <span>上游服务治理 (Upstream Services)</span>
            </h2>
            <span className="text-[11px] text-mist-400">
              共接入 {upstreams.filter((u) => u.status === 'connected').length} / {upstreams.length} 个上游服务
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {/* 1. 本地知识库（四库） */}
            <div className="flex flex-col justify-between rounded-xl border border-ink-750 bg-ink-850 p-4 shadow-xs">
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4 text-blue-500" />
                    <h3 className="text-xs font-semibold text-mist-100">本地知识库</h3>
                  </div>
                  {snapshot ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" />
                      已连接
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-500/10 px-2 py-0.5 text-[11px] font-medium text-zinc-500">
                      <AlertCircle className="h-3 w-3" />
                      未打开项目
                    </span>
                  )}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-mist-400">
                  需求库 / 规范库 / Wiki 库 / 归档库的毫秒级全文检索，供对话与 AI 规划查证项目事实。
                </p>
                <div className="mt-3 space-y-1 font-mono text-[11px] text-mist-400">
                  <div className="truncate">端点: {snapshot?.meta?.root ? `${snapshot.meta.root}/.trellis` : '—'}</div>
                  <div className="text-emerald-400">进程内倒排索引 · 离线可用</div>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-ink-750/60 pt-3">
                <button
                  onClick={() => handleTestUpstream('local-kb')}
                  disabled={testingUpstreamId === 'local-kb' || !snapshot}
                  className="btn-ghost flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40"
                >
                  {testingUpstreamId === 'local-kb' ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Activity size={12} />
                  )}
                  <span>连通性探测</span>
                </button>
                <span className="text-[11px] text-mist-400">2 个工具</span>
              </div>
            </div>

            {/* 2. WeKnora 企业知识库 MCP */}
            <div className="flex flex-col justify-between rounded-xl border border-ink-750 bg-ink-850 p-4 shadow-xs">
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cloud className="h-4 w-4 text-sky-500" />
                    <h3 className="text-xs font-semibold text-mist-100">WeKnora 知识库</h3>
                  </div>
                  {settings?.weknora?.enabled ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" />
                      已连接
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-500/10 px-2 py-0.5 text-[11px] font-medium text-zinc-500">
                      <AlertCircle className="h-3 w-3" />
                      未启用
                    </span>
                  )}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-mist-400">
                  企业级 RAG 知识平台，提供业务规则文档、技术架构标准与跨团队规范向量检索。
                </p>
                <div className="mt-3 space-y-1 font-mono text-[11px] text-mist-400">
                  <div className="truncate">端点: {settings?.weknora?.baseUrl || '未配置'}</div>
                  <div>挂载: {settings?.weknora?.searchKbIds?.length || 0} 个知识库</div>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-ink-750/60 pt-3">
                <button
                  onClick={() => handleTestUpstream('weknora')}
                  disabled={testingUpstreamId === 'weknora' || !settings?.weknora?.enabled}
                  className="btn-ghost flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300 disabled:opacity-40"
                >
                  {testingUpstreamId === 'weknora' ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Activity size={12} />
                  )}
                  <span>连通性探测</span>
                </button>
                <button
                  onClick={() => setPage('settings')}
                  className="text-xs text-mist-400 hover:text-mist-100"
                >
                  配置 →
                </button>
              </div>
            </div>

            {/* 3. Trellis 项目内核 MCP */}
            <div className="flex flex-col justify-between rounded-xl border border-ink-750 bg-ink-850 p-4 shadow-xs">
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileCode className="h-4 w-4 text-emerald-500" />
                    <h3 className="text-xs font-semibold text-mist-100">Trellis 项目内核</h3>
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" />
                    已挂载
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-mist-400">
                  动态注入本地规范文档（.trellis/spec/）与当前活跃任务的 PRD / 设计上下文。
                </p>
                <div className="mt-3 space-y-1 font-mono text-[11px] text-mist-400">
                  <div className="truncate">规范: {snapshot?.spec?.length || 0} 份文档</div>
                  <div>活跃任务: {snapshot?.tasks?.length || 0} 个</div>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-ink-750/60 pt-3">
                <button
                  onClick={() => handleTestUpstream('trellis')}
                  disabled={testingUpstreamId === 'trellis'}
                  className="btn-ghost flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-40"
                >
                  <Activity size={12} />
                  <span>状态探测</span>
                </button>
                <span className="text-[11px] text-mist-400">3 个工具</span>
              </div>
            </div>

            {/* 4. 自定义 MCP 扩展 */}
            <div className="flex flex-col justify-between rounded-xl border border-dashed border-ink-700 bg-ink-850/40 p-4 shadow-xs">
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <PlusCircle className="h-4 w-4 text-purple-500" />
                    <h3 className="text-xs font-semibold text-mist-100">自定义扩展槽位</h3>
                  </div>
                  <span className="rounded-full bg-purple-500/10 px-2 py-0.5 text-[11px] font-medium text-purple-400">
                    Pluggable
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-mist-400">
                  通过 stdio 或 SSE 聚合第三方 MCP 命令行服务（例如 git-mcp, jira-mcp）。
                </p>
              </div>
              <div className="mt-4 border-t border-ink-750/60 pt-3 text-[11px] text-mist-400">
                待挂载第三方服务
              </div>
            </div>
          </div>
        </div>

        {/* 2. 聚合工具注册表与在线调试器 (Tool Catalog & Debugger) */}
        <div className="rounded-xl border border-ink-750 bg-ink-850 p-5 shadow-xs">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-ink-750 pb-4">
            <div>
              <div className="flex items-center gap-2">
                <Code className="h-4 w-4 text-leaf-soft" />
                <h2 className="text-xs font-semibold text-mist-100">聚合工具目录 (Tool Catalog)</h2>
                <span className="rounded-full bg-ink-900 px-2 py-0.5 text-[11px] font-mono text-mist-400 border border-ink-750">
                  {filteredTools.length} 个就绪
                </span>
              </div>
              <p className="mt-0.5 text-xs text-mist-400">
                网关统一暴露给 AI 编辑器的标准工具。点击工具右侧的“在线调试”可直接在面板输入参数实测执行。
              </p>
            </div>

            {/* 分类过滤器 */}
            <div className="flex items-center rounded-lg bg-ink-900 p-1 border border-ink-750 text-xs">
              <button
                onClick={() => setCategoryFilter('all')}
                className={clsx(
                  'rounded px-2.5 py-1 transition-colors',
                  categoryFilter === 'all' ? 'bg-ink-800 font-medium text-mist-100 shadow-xs' : 'text-mist-400 hover:text-mist-100'
                )}
              >
                全部 ({tools.length})
              </button>
              <button
                onClick={() => setCategoryFilter('knowledge')}
                className={clsx(
                  'rounded px-2.5 py-1 transition-colors',
                  categoryFilter === 'knowledge' ? 'bg-ink-800 font-medium text-mist-100 shadow-xs' : 'text-mist-400 hover:text-mist-100'
                )}
              >
                知识库 ({tools.filter((t) => t.upstreamId === 'local-kb' || t.upstreamId === 'weknora').length})
              </button>
              <button
                onClick={() => setCategoryFilter('project')}
                className={clsx(
                  'rounded px-2.5 py-1 transition-colors',
                  categoryFilter === 'project' ? 'bg-ink-800 font-medium text-mist-100 shadow-xs' : 'text-mist-400 hover:text-mist-100'
                )}
              >
                项目内核 ({tools.filter((t) => t.upstreamId === 'trellis').length})
              </button>
            </div>
          </div>

          {/* 工具列表 */}
          <div className="mt-4 divide-y divide-ink-750/60">
            {filteredTools.map((tool) => (
              <div
                key={tool.name}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between first:pt-0 last:pb-0"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-leaf-soft">
                      {tool.name}
                    </span>
                    <span className="rounded bg-ink-900 px-1.5 py-0.5 text-[10px] uppercase font-mono text-mist-400 border border-ink-750">
                      {tool.upstreamId}
                    </span>
                    {tool.securityRule && (
                      <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                        {tool.securityRule}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-mist-400 leading-relaxed">{tool.description}</p>
                  <div className="flex items-center gap-2 font-mono text-[11px] text-mist-400">
                    <span>参数:</span>
                    {Object.keys(tool.parameters).length === 0 ? (
                      <span>无参</span>
                    ) : (
                      Object.entries(tool.parameters).map(([pName, pMeta]) => (
                        <span key={pName} className="rounded border border-ink-800 bg-ink-900 px-1 text-mist-300">
                          {pName}: {pMeta.type}
                          {pMeta.required && <span className="text-rose-500">*</span>}
                        </span>
                      ))
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 sm:self-center">
                  <button
                    onClick={() => handleOpenDebugger(tool)}
                    className="btn-ghost flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs text-mist-200 hover:border-leaf-soft hover:text-leaf-soft"
                  >
                    <Play size={11} className="text-leaf-soft" />
                    <span>在线调试</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 3. 实时调用审计流水 (Invocation & Traffic Audit) */}
        <div className="rounded-xl border border-ink-750 bg-ink-850 p-5 shadow-xs">
          <div className="flex items-center justify-between border-b border-ink-750 pb-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-leaf-soft" />
              <h2 className="text-xs font-semibold text-mist-100">实时调用审计流水 (Invocation Audit)</h2>
              <span className="rounded-full bg-ink-900 px-2 py-0.5 text-[11px] font-mono text-mist-400 border border-ink-750">
                累计 {gatewayStatus?.totalQueries || 0} 次调用
              </span>
            </div>
            <button
              onClick={loadStatus}
              disabled={loadingStatus}
              className="btn-ghost p-1 text-mist-400 hover:text-mist-100"
              title="刷新流水"
            >
              <RefreshCw size={12} className={clsx(loadingStatus && 'animate-spin')} />
            </button>
          </div>

          <div className="mt-3 divide-y divide-ink-750/60">
            {recentLogs.length === 0 ? (
              <div className="py-8 text-center text-xs text-mist-400">
                暂无调用记录。当 AI 编辑器调用网关工具或通过上方“在线调试”发起测试时，此处将实时展示调用入参、耗时与安全防护状态。
              </div>
            ) : (
              recentLogs.map((log) => (
                <div key={log.id} className="py-3 text-xs first:pt-1 last:pb-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={clsx(
                          'rounded px-1.5 py-0.5 text-[10px] font-mono font-medium',
                          log.status === 'success' && 'bg-emerald-500/10 text-emerald-400',
                          log.status === 'blocked' && 'bg-rose-500/10 text-rose-400',
                          log.status === 'error' && 'bg-amber-500/10 text-amber-400'
                        )}
                      >
                        {log.status === 'success' ? '200 OK' : log.status === 'blocked' ? '403 BLOCKED' : '500 ERROR'}
                      </span>
                      <span className="font-mono font-semibold text-mist-100">
                        {log.toolName || log.query || 'mcp_call'}
                      </span>
                      <span className="text-[11px] text-mist-400 font-mono">[{log.upstreamId || 'gateway'}]</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-emerald-400">
                        {log.elapsedMs}ms
                      </span>
                      <span className="text-[11px] text-mist-400">{relTime(log.timestamp)}</span>
                    </div>
                  </div>

                  {/* 详细入参与拦截/响应预览 */}
                  <div className="mt-1.5 space-y-1 text-[11px]">
                    {log.input && Object.keys(log.input).length > 0 && (
                      <div className="font-mono text-mist-400">
                        入参: <code className="text-mist-200">{JSON.stringify(log.input)}</code>
                      </div>
                    )}
                    {log.error && (
                      <div className="text-rose-500 font-mono">
                        {log.error}
                      </div>
                    )}
                    {log.responsePreview && (
                      <div className="text-mist-400 font-mono truncate max-w-4xl">
                        响应: {log.responsePreview}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 模态框 1: 在线调试器 (Tool Debugger Drawer/Modal) */}
      {selectedTool && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => e.target === e.currentTarget && setSelectedTool(null)}
        >
          <div className="w-full max-w-2xl rounded-xl border border-ink-700 bg-ink-850 p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-ink-700 pb-3">
              <div className="flex items-center gap-2">
                <Play size={16} className="text-leaf-soft" />
                <h3 className="text-sm font-semibold text-mist-100">
                  在线工具调试: <span className="font-mono text-leaf-soft">{selectedTool.name}</span>
                </h3>
              </div>
              <button
                onClick={() => setSelectedTool(null)}
                className="btn-ghost p-1 text-mist-400 hover:text-mist-100"
              >
                <X size={14} />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <p className="text-xs text-mist-300 leading-relaxed">{selectedTool.description}</p>

              {/* 参数输入 */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-mist-100">调用入参 (Parameters)</h4>
                {Object.keys(selectedTool.parameters).length === 0 ? (
                  <div className="rounded-lg border border-ink-750 bg-ink-900 p-3 text-xs text-mist-400">
                    该工具为无参工具，直接点击下方“执行调用”即可。
                  </div>
                ) : (
                  Object.entries(selectedTool.parameters).map(([pName, pMeta]) => (
                    <div key={pName} className="space-y-1">
                      <label className="flex items-center justify-between text-xs font-medium text-mist-200">
                        <span>
                          {pName} ({pMeta.type})
                          {pMeta.required && <span className="text-rose-500 ml-1">*</span>}
                        </span>
                        <span className="text-[11px] text-mist-400">{pMeta.description}</span>
                      </label>
                      {pName === 'sql' ? (
                        <textarea
                          rows={3}
                          value={toolArgs[pName] || ''}
                          onChange={(e) => setToolArgs({ ...toolArgs, [pName]: e.target.value })}
                          className="w-full rounded-lg border border-ink-700 bg-ink-900 p-2.5 font-mono text-xs text-mist-100 placeholder:text-mist-500 focus:border-leaf-soft focus:outline-none"
                          placeholder="输入 SQL 语句，例如 SELECT * FROM t_order LIMIT 5"
                        />
                      ) : (
                        <input
                          type="text"
                          value={toolArgs[pName] || ''}
                          onChange={(e) => setToolArgs({ ...toolArgs, [pName]: e.target.value })}
                          className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-xs text-mist-100 placeholder:text-mist-500 focus:border-leaf-soft focus:outline-none"
                          placeholder={`输入 ${pName}`}
                        />
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* 快捷测试按钮提示 */}
              {selectedTool.name === 'kb_search' && (
                <div className="flex items-center gap-2 text-[11px] text-mist-400">
                  <span>快捷填入:</span>
                  <button
                    onClick={() => setToolArgs({ query: '项目规范', library: 'spec' })}
                    className="underline hover:text-mist-200"
                  >
                    检索规范库
                  </button>
                  <span>·</span>
                  <button
                    onClick={() => setToolArgs({ query: '归档任务', library: 'archive' })}
                    className="underline hover:text-mist-200"
                  >
                    检索归档库
                  </button>
                </div>
              )}

              {/* 调试执行结果 */}
              {testResult && (
                <div className="space-y-2 border-t border-ink-700 pt-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-mist-100">执行结果</span>
                    <span className="font-mono text-xs text-emerald-400">
                      耗时: {testResult.elapsedMs}ms
                    </span>
                  </div>
                  {testResult.blockedBySecurity ? (
                    <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-400 space-y-1">
                      <div className="flex items-center gap-1.5 font-semibold">
                        <AlertTriangle size={14} />
                        <span>网关安全防线触发：执行被拦截！</span>
                      </div>
                      <p>{testResult.error}</p>
                    </div>
                  ) : testResult.ok ? (
                    <pre className="max-h-60 overflow-y-auto rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-[11px] text-mist-200 leading-relaxed">
                      {JSON.stringify(testResult.result, null, 2)}
                    </pre>
                  ) : (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-400">
                      {testResult.error}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-2 border-t border-ink-700 pt-4">
              <button
                onClick={() => setSelectedTool(null)}
                className="btn-ghost px-4 py-1.5 text-xs text-mist-400"
              >
                关闭
              </button>
              <button
                onClick={handleExecuteTool}
                disabled={executingTool}
                className="btn-primary flex items-center gap-1.5 px-4 py-1.5 text-xs"
              >
                {executingTool ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                <span>执行调用 (Run)</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 模态框 2: 网关安全策略设置 (Security Guardrails Modal) */}
      {showSecurityModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => e.target === e.currentTarget && setShowSecurityModal(false)}
        >
          <div className="w-full max-w-md rounded-xl border border-ink-700 bg-ink-850 p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-ink-700 pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck size={16} className="text-emerald-500" />
                <h3 className="text-sm font-semibold text-mist-100">网关安全防线与熔断策略</h3>
              </div>
              <button
                onClick={() => setShowSecurityModal(false)}
                className="btn-ghost p-1 text-mist-400 hover:text-mist-100"
              >
                <X size={14} />
              </button>
            </div>

            <div className="mt-4 space-y-4 text-xs">
              <div className="flex items-center justify-between rounded-lg border border-ink-750 bg-ink-900 p-3">
                <div>
                  <div className="font-semibold text-mist-100">SQL 只读安全拦截 (Strict Read-Only)</div>
                  <p className="mt-0.5 text-mist-400">强制阻断 DROP / DELETE / UPDATE / ALTER 等写操作</p>
                </div>
                <input
                  type="checkbox"
                  checked={securityForm.sqlReadOnly}
                  onChange={(e) => setSecurityForm({ ...securityForm, sqlReadOnly: e.target.checked })}
                  className="h-4 w-4 rounded accent-leaf-soft"
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-mist-100">上游调用硬超时熔断 (毫秒)</label>
                <input
                  type="number"
                  value={securityForm.timeoutMs}
                  onChange={(e) => setSecurityForm({ ...securityForm, timeoutMs: Number(e.target.value) || 2000 })}
                  className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-mist-100 focus:border-leaf-soft focus:outline-none"
                />
                <p className="text-[11px] text-mist-400">超过设定时间立即熔断返回，防止外部服务慢拖垮 AI 编辑器</p>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-mist-100">最大响应字符截断限制</label>
                <input
                  type="number"
                  value={securityForm.maxResponseChars}
                  onChange={(e) => setSecurityForm({ ...securityForm, maxResponseChars: Number(e.target.value) || 12000 })}
                  className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-mist-100 focus:border-leaf-soft focus:outline-none"
                />
                <p className="text-[11px] text-mist-400">限制单次工具返回的最大字符数，防止超大表查询撑爆模型上下文</p>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2 border-t border-ink-700 pt-4">
              <button
                onClick={() => setShowSecurityModal(false)}
                className="btn-ghost px-4 py-1.5 text-xs text-mist-400"
              >
                取消
              </button>
              <button
                onClick={handleSaveSecurity}
                className="btn-primary px-4 py-1.5 text-xs"
              >
                保存策略
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 模态框 3: 接入 AI 编辑器 (Mount Config Modal) */}
      {showMountModal && mcpInstallResult && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => e.target === e.currentTarget && setShowMountModal(false)}
        >
          <div className="w-full max-w-xl rounded-xl border border-ink-700 bg-ink-850 p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-ink-700 pb-3">
              <div className="flex items-center gap-2">
                <Terminal size={16} className="text-leaf-soft" />
                <h3 className="text-sm font-semibold text-mist-100">接入 AI 编程编辑器 (MCP Client Config)</h3>
              </div>
              <button
                onClick={() => setShowMountModal(false)}
                className="btn-ghost p-1 text-mist-400 hover:text-mist-100"
              >
                <X size={14} />
              </button>
            </div>

            <div className="mt-4 space-y-4 text-xs">
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-emerald-400 leading-relaxed">
                网关脚本已就绪：<br />
                <code className="font-mono text-[11px] break-all">{mcpInstallResult.scriptPath}</code>
              </div>

              {/* Claude Code */}
              <div className="rounded-lg border border-ink-750 bg-ink-900 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-mist-100">Claude Code (.mcp.json)</span>
                  <button
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
                    className="btn-ghost flex items-center gap-1 text-[11px] text-mist-400 hover:text-mist-100"
                  >
                    {copiedKey === 'claude' ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                    <span>复制 JSON</span>
                  </button>
                </div>
                <pre className="mt-2 overflow-x-auto rounded border border-ink-800 bg-ink-950 p-2 font-mono text-[11px] text-mist-300">
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
              <div className="rounded-lg border border-ink-750 bg-ink-900 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-mist-100">Codex (~/.codex/config.toml)</span>
                  <button
                    onClick={() =>
                      copySnippet(
                        'codex',
                        `[mcp_servers.trellis-gateway]\ncommand = "node"\nargs = ["${mcpInstallResult.scriptPath}", "--root", "${snapshot?.meta.root || '.'}"]`
                      )
                    }
                    className="btn-ghost flex items-center gap-1 text-[11px] text-mist-400 hover:text-mist-100"
                  >
                    {copiedKey === 'codex' ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                    <span>复制 TOML</span>
                  </button>
                </div>
                <pre className="mt-2 overflow-x-auto rounded border border-ink-800 bg-ink-950 p-2 font-mono text-[11px] text-mist-300">
{`[mcp_servers.trellis-gateway]
command = "node"
args = ["${mcpInstallResult.scriptPath}", "--root", "${snapshot?.meta.root || '.'}"]`}
                </pre>
              </div>
            </div>

            <div className="mt-6 flex justify-end border-t border-ink-700 pt-4">
              <button
                onClick={() => setShowMountModal(false)}
                className="btn-primary px-4 py-1.5 text-xs"
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
