import { useCallback, useEffect, useState } from 'react'
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
  Settings2,
  Code,
  FileCode,
  ArrowUpRight
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { Button, Checkbox } from '../my/ui'
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
    <div className="min-w-0 p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* 状态徽标与操作栏 */}
        <div className="flex flex-col gap-3 border-b border-my-line pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <span className="my-chip bg-my-success-subtle text-my-success-text">
              <span className="h-1.5 w-1.5 rounded-full bg-my-success animate-pulse" />
              Active · stdio
            </span>
            <span className="my-chip bg-my-accent-subtle text-my-accent-text">
              {tools.length} 个聚合工具
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setShowSecurityModal(true)}
              title="配置安全防护与熔断参数"
            >
              <ShieldCheck size={13} className="text-my-success-text" />
              <span>安全策略</span>
            </Button>
            <Button variant="outline" onClick={loadStatus} disabled={loadingStatus} title="刷新网关状态">
              <RefreshCw size={12} className={clsx(loadingStatus && 'animate-spin')} />
              <span>刷新</span>
            </Button>
            <Button variant="primary" onClick={handleOpenMountModal} disabled={installingMcp}>
              <Terminal size={12} />
              <span>接入 AI 编辑器</span>
            </Button>
          </div>
        </div>

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
                  {snapshot ? (
                    <span className="my-chip bg-my-success-subtle text-my-success-text">
                      <CheckCircle2 className="h-3 w-3" />
                      已连接
                    </span>
                  ) : (
                    <span className="my-chip bg-my-layer-3 text-my-tertiary">
                      <AlertCircle className="h-3 w-3" />
                      未打开项目
                    </span>
                  )}
                </div>
                <p className="mt-2 text-my-xs leading-relaxed text-my-tertiary">
                  需求库 / 规范库 / Wiki 库 / 归档库的毫秒级全文检索，供对话与 AI 规划查证项目事实。
                </p>
                <div className="mt-3 space-y-1 font-mono text-my-xs text-my-tertiary">
                  <div className="truncate">端点: {snapshot?.meta?.root ? `${snapshot.meta.root}/.trellis` : '—'}</div>
                  <div className="text-my-success-text">进程内倒排索引 · 离线可用</div>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-my-line pt-3">
                <button
                  onClick={() => handleTestUpstream('local-kb')}
                  disabled={testingUpstreamId === 'local-kb' || !snapshot}
                  className="my-control my-control-sm text-my-info-text hover:text-[var(--my-txt-info-secondary)] disabled:opacity-40"
                >
                  {testingUpstreamId === 'local-kb' ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Activity size={12} />
                  )}
                  <span>连通性探测</span>
                </button>
                <span className="text-my-xs text-my-tertiary">2 个工具</span>
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
                  {settings?.weknora?.enabled ? (
                    <span className="my-chip bg-my-success-subtle text-my-success-text">
                      <CheckCircle2 className="h-3 w-3" />
                      已连接
                    </span>
                  ) : (
                    <span className="my-chip bg-my-layer-3 text-my-tertiary">
                      <AlertCircle className="h-3 w-3" />
                      未启用
                    </span>
                  )}
                </div>
                <p className="mt-2 text-my-xs leading-relaxed text-my-tertiary">
                  企业级 RAG 知识平台，提供业务规则文档、技术架构标准与跨团队规范向量检索。
                </p>
                <div className="mt-3 space-y-1 font-mono text-my-xs text-my-tertiary">
                  <div className="truncate">端点: {settings?.weknora?.baseUrl || '未配置'}</div>
                  <div>挂载: {settings?.weknora?.searchKbIds?.length || 0} 个知识库</div>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-my-line pt-3">
                <button
                  onClick={() => handleTestUpstream('weknora')}
                  disabled={testingUpstreamId === 'weknora' || !settings?.weknora?.enabled}
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
                  onClick={() => setPage('settings')}
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
                  <span className="my-chip bg-my-success-subtle text-my-success-text">
                    <CheckCircle2 className="h-3 w-3" />
                    已挂载
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
                  disabled={testingUpstreamId === 'trellis'}
                  className="my-control my-control-sm text-my-success-text hover:text-[var(--my-txt-success-secondary)] disabled:opacity-40"
                >
                  <Activity size={12} />
                  <span>状态探测</span>
                </button>
                <span className="text-my-xs text-my-tertiary">3 个工具</span>
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
                  {filteredTools.length} 个就绪
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
                    className="my-control border border-my-line bg-my-canvas text-my-secondary hover:border-my-line-accent-subtle hover:text-my-accent-text"
                  >
                    <Play size={11} className="text-my-accent-text" />
                    <span>在线调试</span>
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
            <Button variant="ghost" size="sm" onClick={loadStatus} disabled={loadingStatus} title="刷新流水">
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
      </div>

      {/* 模态框 1: 在线调试器 (Tool Debugger Drawer/Modal) */}
      {selectedTool && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-my-backdrop p-4"
          onMouseDown={(e) => e.target === e.currentTarget && setSelectedTool(null)}
        >
          <div className="w-full max-w-2xl rounded-my-xl border border-my-line bg-my-layer-2 p-6 shadow-[var(--my-shadow-overlay-200)]">
            <div className="flex items-center justify-between border-b border-my-line pb-3">
              <div className="flex items-center gap-2">
                <Play size={16} className="text-my-accent-text" />
                <h3 className="text-my-sm font-semibold text-my-primary">
                  在线工具调试: <span className="font-mono text-my-accent-text">{selectedTool.name}</span>
                </h3>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelectedTool(null)}>
                <X size={14} />
              </Button>
            </div>

            <div className="mt-4 space-y-4">
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
                      <label className="flex items-center justify-between text-my-xs font-medium text-my-secondary">
                        <span>
                          {pName} ({pMeta.type})
                          {pMeta.required && <span className="text-my-danger-text ml-1">*</span>}
                        </span>
                        <span className="text-my-xs text-my-tertiary">{pMeta.description}</span>
                      </label>
                      {pName === 'sql' ? (
                        <textarea
                          rows={3}
                          value={toolArgs[pName] || ''}
                          onChange={(e) => setToolArgs({ ...toolArgs, [pName]: e.target.value })}
                          className="w-full rounded-my-md border border-my-line bg-my-surface-1 p-2.5 font-mono text-my-xs text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent"
                          placeholder="输入 SQL 语句，例如 SELECT * FROM t_order LIMIT 5"
                        />
                      ) : (
                        <input
                          type="text"
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
                    onClick={() => setToolArgs({ query: '项目规范', library: 'spec' })}
                    className="underline hover:text-my-secondary"
                  >
                    检索规范库
                  </button>
                  <span>·</span>
                  <button
                    onClick={() => setToolArgs({ query: '归档任务', library: 'archive' })}
                    className="underline hover:text-my-secondary"
                  >
                    检索归档库
                  </button>
                </div>
              )}

              {/* 调试执行结果 */}
              {testResult && (
                <div className="space-y-2 border-t border-my-line pt-3">
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

            <div className="mt-6 flex justify-end gap-2 border-t border-my-line pt-4">
              <Button variant="ghost" onClick={() => setSelectedTool(null)}>
                关闭
              </Button>
              <Button variant="primary" onClick={handleExecuteTool} disabled={executingTool}>
                {executingTool ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                <span>执行调用 (Run)</span>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 模态框 2: 网关安全策略设置 (Security Guardrails Modal) */}
      {showSecurityModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-my-backdrop p-4"
          onMouseDown={(e) => e.target === e.currentTarget && setShowSecurityModal(false)}
        >
          <div className="w-full max-w-md rounded-my-xl border border-my-line bg-my-layer-2 p-6 shadow-[var(--my-shadow-overlay-200)]">
            <div className="flex items-center justify-between border-b border-my-line pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck size={16} className="text-my-success-text" />
                <h3 className="text-my-sm font-semibold text-my-primary">网关安全防线与熔断策略</h3>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setShowSecurityModal(false)}>
                <X size={14} />
              </Button>
            </div>

            <div className="mt-4 space-y-4 text-my-xs">
              <div className="flex items-center justify-between rounded-my-lg border border-my-line bg-my-canvas p-3">
                <div>
                  <div className="font-semibold text-my-primary">SQL 只读安全拦截 (Strict Read-Only)</div>
                  <p className="mt-0.5 text-my-tertiary">强制阻断 DROP / DELETE / UPDATE / ALTER 等写操作</p>
                </div>
                <Checkbox
                  checked={securityForm.sqlReadOnly}
                  onChange={(v) => setSecurityForm({ ...securityForm, sqlReadOnly: v })}
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-my-primary">上游调用硬超时熔断 (毫秒)</label>
                <input
                  type="number"
                  value={securityForm.timeoutMs}
                  onChange={(e) => setSecurityForm({ ...securityForm, timeoutMs: Number(e.target.value) || 2000 })}
                  className="my-input"
                />
                <p className="text-my-xs text-my-tertiary">超过设定时间立即熔断返回，防止外部服务慢拖垮 AI 编辑器</p>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-my-primary">最大响应字符截断限制</label>
                <input
                  type="number"
                  value={securityForm.maxResponseChars}
                  onChange={(e) => setSecurityForm({ ...securityForm, maxResponseChars: Number(e.target.value) || 12000 })}
                  className="my-input"
                />
                <p className="text-my-xs text-my-tertiary">限制单次工具返回的最大字符数，防止超大表查询撑爆模型上下文</p>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2 border-t border-my-line pt-4">
              <Button variant="ghost" onClick={() => setShowSecurityModal(false)}>
                取消
              </Button>
              <Button variant="primary" onClick={handleSaveSecurity}>
                保存策略
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 模态框 3: 接入 AI 编辑器 (Mount Config Modal) */}
      {showMountModal && mcpInstallResult && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-my-backdrop p-4"
          onMouseDown={(e) => e.target === e.currentTarget && setShowMountModal(false)}
        >
          <div className="w-full max-w-xl rounded-my-xl border border-my-line bg-my-layer-2 p-6 shadow-[var(--my-shadow-overlay-200)]">
            <div className="flex items-center justify-between border-b border-my-line pb-3">
              <div className="flex items-center gap-2">
                <Terminal size={16} className="text-my-accent-text" />
                <h3 className="text-my-sm font-semibold text-my-primary">接入 AI 编程编辑器 (MCP Client Config)</h3>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setShowMountModal(false)}>
                <X size={14} />
              </Button>
            </div>

            <div className="mt-4 space-y-4 text-my-xs">
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
                    {copiedKey === 'claude' ? <Check size={12} className="text-my-success-text" /> : <Copy size={12} />}
                    <span>复制 JSON</span>
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
                    onClick={() =>
                      copySnippet(
                        'codex',
                        `[mcp_servers.trellis-gateway]\ncommand = "node"\nargs = ["${mcpInstallResult.scriptPath}", "--root", "${snapshot?.meta.root || '.'}"]`
                      )
                    }
                  >
                    {copiedKey === 'codex' ? <Check size={12} className="text-my-success-text" /> : <Copy size={12} />}
                    <span>复制 TOML</span>
                  </Button>
                </div>
                <pre className="mt-2 overflow-x-auto rounded-my-sm border border-my-line bg-my-canvas p-2 font-mono text-my-xs text-my-secondary">
{`[mcp_servers.trellis-gateway]
command = "node"
args = ["${mcpInstallResult.scriptPath}", "--root", "${snapshot?.meta.root || '.'}"]`}
                </pre>
              </div>
            </div>

            <div className="mt-6 flex justify-end border-t border-my-line pt-4">
              <Button variant="primary" onClick={() => setShowMountModal(false)}>
                完成
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
