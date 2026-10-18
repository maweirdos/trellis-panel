// 本机开发工具（C1/C2/C3）：当前工程只读 Git（状态/基线/差异，无任何写操作）
// 与工程脚本运行（脚本来自 package.json，进程归属面板，停止只作用于自己的进程树）。
// 诚实边界：进程存活 ≠ 服务就绪；无 Git / 无桥接时中性降级，不伪装能力。
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { clsx } from 'clsx'
import { FolderPlus, Loader2, Pause, Play, Plus, RefreshCw, Square, X } from 'lucide-react'
import { api, hasIpc } from '../../api'
import { useApp } from '../../store'
import { useMy } from '../store'
import { projectRootKey } from '../navigation'
import { Button } from '../ui'
import { Select } from '../../components/Select'
import type { DevRunInfo, DevScriptInfo, GitReadonlyFileDiff, GitReadonlyStatus } from '../../../../shared/types'

const STATUS_LABELS: Record<string, string> = {
  M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', T: '类型变更', U: '冲突未合', X: '未知', ' ': '无变更'
}
const codeLabel = (c: string): string => STATUS_LABELS[c] ?? c

function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  return `${Math.floor(s / 3600)} 小时前`
}

function dirName(path: string): string {
  const norm = path.replace(/[\\/]+$/, '')
  return norm.split(/[\\/]/).pop() ?? path
}

/* ---------------- 只读 Git（C1） ---------------- */

function GitSection(): JSX.Element {
  const [status, setStatus] = useState<GitReadonlyStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState<GitReadonlyFileDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (!hasIpc) return
    setLoading(true)
    try {
      setStatus(await api.devtoolsGitStatus())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const openDiff = async (path: string, staged: boolean): Promise<void> => {
    setSelected({ path, staged })
    setDiffLoading(true)
    setDiff(null)
    try {
      setDiff(await api.devtoolsGitFileDiff(path, staged))
    } finally {
      setDiffLoading(false)
    }
  }

  const groups: Array<{ key: string; title: string; entries: Array<{ path: string; note: string }>; staged: boolean }> = status
    ? [
        { key: 'staged', title: `暂存区改动（${status.staged.length}）`, staged: true, entries: status.staged.map((e) => ({ path: e.path, note: `${codeLabel(e.x)}${e.origPath ? ` ← ${e.origPath}` : ''}` })) },
        { key: 'unstaged', title: `未暂存改动（${status.unstaged.length}）`, staged: false, entries: status.unstaged.map((e) => ({ path: e.path, note: codeLabel(e.y) })) }
      ]
    : []

  return (
    <section aria-label="只读 Git" className="rounded-my-xl border border-my-line bg-my-layer-1 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-my-md font-semibold text-my-primary">Git（只读）</h2>
        {status?.ok && status.isRepo && (
          <span className="my-chip bg-my-layer-1 text-my-secondary">
            {status.branch ?? '未知分支'}{status.head ? ` · 基线 ${status.head.short} ${status.head.subject.slice(0, 40)}` : ''}
          </span>
        )}
        <Button variant="ghost" size="sm" className="ml-auto justify-center px-2" onClick={() => void refresh()} title="刷新">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </Button>
      </div>
      <p className="mb-3 text-my-xs leading-5 text-my-tertiary">
        基线为当前 HEAD；已有脏改动可能包含此前未关联的工作，归属以 git 为准。本入口不提供提交/切分支/重置等任何写操作。
      </p>
      {!status && <p className="text-my-sm text-my-tertiary">读取中…</p>}
      {status && !status.isRepo && (
        <p className="rounded-my-md border border-my-line bg-my-layer-1 px-3 py-2 text-my-sm text-my-secondary">{status.error ?? '当前项目目录不是 git 仓库'}</p>
      )}
      {status && status.isRepo && !status.ok && (
        <p className="rounded-my-md border border-my-line-danger bg-my-danger-subtle px-3 py-2 text-my-sm text-my-danger-text">{status.error ?? 'git 读取失败'}</p>
      )}
      {status && status.ok && status.isRepo && (
        <div className="grid gap-3 lg:grid-cols-2">
          {groups.map((group) => (
            <div key={group.key}>
              <h3 className="mb-1 text-my-xs font-medium text-my-tertiary">{group.title}</h3>
              {group.entries.length === 0 && <p className="px-1 text-my-sm text-my-tertiary">无</p>}
              <ul className="max-h-48 overflow-y-auto my-scrollbar">
                {group.entries.map((e) => (
                  <li key={`${group.key}:${e.path}`}>
                    <button
                      type="button"
                      onClick={() => void openDiff(e.path, group.staged)}
                      className={clsx(
                        'flex w-full items-baseline gap-2 rounded-my-md px-2 py-1 text-left hover:bg-my-layer-transparent-hover',
                        selected?.path === e.path && selected?.staged === group.staged && 'bg-my-layer-transparent-selected'
                      )}
                    >
                      <span className="my-chip shrink-0 bg-my-layer-1 text-my-tertiary">{group.staged ? '暂存' : '未暂存'}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-my-xs text-my-secondary" title={e.path}>{e.path}</span>
                      <span className="shrink-0 text-my-xs text-my-tertiary">{e.note}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="lg:col-span-2">
            <h3 className="mb-1 text-my-xs font-medium text-my-tertiary">未跟踪（{status.untracked.length}）</h3>
            {status.untracked.length === 0 && <p className="px-1 text-my-sm text-my-tertiary">无</p>}
            <ul className="max-h-32 overflow-y-auto my-scrollbar">
              {status.untracked.map((p) => (
                <li key={p} className="flex items-baseline gap-2 rounded-my-md px-2 py-1">
                  <span className="my-chip shrink-0 bg-my-layer-1 text-my-tertiary">未跟踪</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-my-xs text-my-secondary" title={p}>{p}</span>
                  <span className="shrink-0 text-my-xs text-my-tertiary">无基线差异</span>
                </li>
              ))}
            </ul>
          </div>
          {selected && (
            <div className="lg:col-span-2">
              <div className="mb-1 flex items-center gap-2">
                <h3 className="min-w-0 flex-1 truncate font-mono text-my-xs text-my-secondary" title={selected.path}>
                  {selected.path} · {selected.staged ? '与 HEAD 的暂存差异' : '工作区未暂存差异'}
                </h3>
                <Button variant="ghost" size="sm" className="justify-center px-2" onClick={() => { setSelected(null); setDiff(null) }} title="关闭差异">
                  <X size={12} />
                </Button>
              </div>
              {diffLoading && <p className="text-my-sm text-my-tertiary">差异生成中…</p>}
              {diff && !diffLoading && !diff.ok && (
                <p className="rounded-my-md border border-my-line-warning bg-my-warning-subtle px-3 py-2 text-my-xs text-my-warning-text">{diff.error ?? '差异读取失败'}</p>
              )}
              {diff && diff.ok && (
                <>
                  <p className="mb-1 text-my-xs text-my-tertiary">
                    {diff.binary
                      ? '二进制文件，不展示文本差异'
                      : `+${diff.added} / -${diff.removed}${diff.truncated ? ' · 输出过长已截断' : ''}`}
                  </p>
                  {!diff.binary && (
                    <pre className="my-scrollbar max-h-72 overflow-auto rounded-my-md border border-my-line bg-my-canvas p-2 font-mono text-my-2xs leading-4 text-my-secondary">{diff.diff || '（无差异内容）'}</pre>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/* ---------------- 工程运行与日志（C2/C3） ---------------- */

const RUN_STATE_LABELS: Record<DevRunInfo['state'], string> = {
  running: '进程运行中（不代表服务已就绪）',
  exited: '已退出',
  failed: '异常退出',
  killed: '已停止'
}

function RunConsole({ run, follow, onToggleFollow }: { run: DevRunInfo; follow: boolean; onToggleFollow: (v: boolean) => void }): JSX.Element {
  const preRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (follow && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [run.output, follow])
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-my-xs font-medium text-my-tertiary">
          输出 · {run.command}（{dirName(run.dir)}）
          {run.outputTruncated ? ' · 早期输出已截断' : ''}
        </h3>
        <button
          type="button"
          onClick={() => onToggleFollow(!follow)}
          title={follow ? '暂停跟随（不停止进程）' : '恢复跟随'}
          className="flex h-6 items-center gap-1 rounded px-1.5 text-my-xs text-my-secondary hover:bg-my-layer-1-hover"
        >
          {follow ? <><Pause size={11} /> 暂停跟随</> : <><Play size={11} /> 恢复跟随</>}
        </button>
      </div>
      <pre ref={preRef} className="my-scrollbar max-h-80 min-h-24 overflow-auto rounded-my-md border border-my-line bg-my-canvas p-2 font-mono text-my-2xs leading-4 text-my-secondary">{run.output || '（尚无输出）'}</pre>
    </div>
  )
}

function RunSection(): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const snapshot = useApp((s) => s.snapshot)
  const root = snapshot?.meta.root ?? null
  const [dirs, setDirs] = useState<string[]>([])
  const [scripts, setScripts] = useState<Record<string, DevScriptInfo[]>>({})
  const [scriptsError, setScriptsError] = useState<Record<string, string>>({})
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [runs, setRuns] = useState<DevRunInfo[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const [busy, setBusy] = useState(false)

  // 默认包含当前项目根；项目切换后只补缺，不覆盖用户已添加的组合
  useEffect(() => {
    if (root) setDirs((prev) => (prev.some((d) => d.toLowerCase() === root.toLowerCase()) ? prev : [...prev, root]))
  }, [root])

  const loadScripts = useCallback(async (dir: string): Promise<void> => {
    const res = await api.devtoolsListScripts(dir)
    if (res.ok) {
      setScripts((prev) => ({ ...prev, [dir]: res.scripts }))
      setPicked((prev) => (prev[dir] ? prev : { ...prev, [dir]: res.scripts.find((s) => s.name === 'dev')?.name ?? res.scripts[0]?.name ?? '' }))
    } else {
      setScriptsError((prev) => ({ ...prev, [dir]: res.error ?? '无法读取脚本' }))
    }
  }, [])

  useEffect(() => {
    if (!hasIpc) return
    for (const dir of dirs) {
      if (scripts[dir] === undefined && scriptsError[dir] === undefined) void loadScripts(dir)
    }
  }, [dirs, scripts, scriptsError, loadScripts])

  const refreshRuns = useCallback(async (): Promise<void> => {
    if (!hasIpc) return
    const res = await api.devRunList()
    setRuns(res.runs)
  }, [])

  useEffect(() => {
    if (!hasIpc) return
    void refreshRuns()
    const t = setInterval(() => { void refreshRuns() }, 2000)
    return () => clearInterval(t)
  }, [refreshRuns])

  const start = async (dir: string, script: string): Promise<void> => {
    if (!script) return
    setBusy(true)
    try {
      const res = await api.devRunStart(dir, script)
      if (res.ok && res.run) {
        setSelectedRunId(res.run.id)
        setFollow(true)
      } else {
        pushToast({ kind: 'error', title: '启动失败', body: res.error ?? '未知错误' })
      }
      await refreshRuns()
    } finally {
      setBusy(false)
    }
  }

  const startCombo = async (): Promise<void> => {
    const failures: string[] = []
    for (const dir of dirs) {
      const script = picked[dir]
      if (!script) continue
      const res = await api.devRunStart(dir, script)
      if (res.ok && res.run) setSelectedRunId(res.run.id)
      else failures.push(`${dirName(dir)}：${res.error ?? '未知错误'}`)
    }
    if (failures.length > 0) {
      pushToast({ kind: 'warn', title: '组合启动部分失败', body: `${failures.join('；')}——失败工程已标出，成功工程继续运行` })
    } else if (dirs.length > 0) {
      pushToast({ kind: 'success', title: '组合已按顺序启动', body: '各自状态见运行列表；进程存活不代表服务已就绪' })
    }
    await refreshRuns()
  }

  const stop = async (id: string): Promise<void> => {
    const res = await api.devRunStop(id)
    if (!res.ok) pushToast({ kind: 'warn', title: '停止未执行', body: res.error ?? '未知错误' })
    await refreshRuns()
  }

  const stopAll = async (): Promise<void> => {
    const res = await api.devRunStopAll()
    pushToast({ kind: res.stopped > 0 ? 'success' : 'info', title: `已停止 ${res.stopped} 个运行`, body: '仅作用于面板自己启动的进程' })
    await refreshRuns()
  }

  const addDir = async (): Promise<void> => {
    if (!hasIpc) return
    const picked2 = await api.pickProject()
    if (!picked2) return
    setDirs((prev) => (prev.some((d) => d.toLowerCase() === picked2.toLowerCase()) ? prev : [...prev, picked2]))
  }

  const selectedRun = useMemo(() => runs.find((r) => r.id === selectedRunId) ?? null, [runs, selectedRunId])
  const runningCount = runs.filter((r) => r.state === 'running').length

  return (
    <section aria-label="工程运行与日志" className="rounded-my-xl border border-my-line bg-my-layer-1 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-my-md font-semibold text-my-primary">工程运行与日志</h2>
        <span className="my-chip bg-my-layer-1 text-my-secondary">{runningCount} 个运行中</span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void addDir()} title="添加工程目录">
            <FolderPlus size={13} /> 添加工程
          </Button>
          <Button variant="ghost" size="sm" disabled={busy || dirs.length === 0} onClick={() => void startCombo()} title="按列表顺序逐个启动各工程的选中脚本">
            <Plus size={13} /> 启动组合
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void stopAll()} title="停止面板启动的全部运行">
            <Square size={11} /> 全部停止
          </Button>
        </div>
      </div>
      <p className="mb-3 text-my-xs leading-5 text-my-tertiary">
        脚本来自各工程 package.json，面板不修改脚本；启动前请核对目录与命令。停止只作用于面板自己启动的进程树，外部终端进程不受影响。
        没有就绪检查时仅显示进程存活，不代表服务可用；部分失败会在列表中标出具体工程。
      </p>
      {!hasIpc && <p className="text-my-sm text-my-tertiary">浏览器预览无本机进程能力——请在桌面应用中使用。</p>}
      {hasIpc && (
        <>
          <div className="mb-3 space-y-2">
            {dirs.map((dir) => {
              const list = scripts[dir]
              const err = scriptsError[dir]
              return (
                <div key={dir} className="flex flex-wrap items-center gap-2 rounded-my-md border border-my-line bg-my-layer-1 px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-my-xs text-my-secondary" title={dir}>{dirName(dir)}<span className="ml-1.5 text-my-tertiary">{dir}</span></span>
                  {list && list.length > 0 && (
                    <Select
                      value={picked[dir] ?? ''}
                      onChange={(value) => setPicked((previous) => ({ ...previous, [dir]: value }))}
                      className="max-w-56"
                      size="sm"
                      ariaLabel={`${dirName(dir)} 的启动脚本`}
                      options={list.map((script) => ({ value: script.name, label: `${script.name} = ${script.command}` }))}
                    />
                  )}
                  {list && list.length === 0 && <span className="text-my-xs text-my-tertiary">package.json 没有脚本</span>}
                  {err && <span className="text-my-xs text-my-warning-text">{err}</span>}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || !picked[dir]}
                    onClick={() => void start(dir, picked[dir] ?? '')}
                    title={`在 ${dir} 执行 npm run ${picked[dir] ?? ''}`}
                  >
                    <Play size={12} /> 启动
                  </Button>
                  {!root || dir.toLowerCase() !== root.toLowerCase() ? (
                    <button
                      type="button"
                      aria-label={`移除工程 ${dirName(dir)}`}
                      onClick={() => {
                        setDirs((prev) => prev.filter((d) => d !== dir))
                        setPicked((prev) => { const n = { ...prev }; delete n[dir]; return n })
                      }}
                      className="p-1 text-my-icon-tertiary hover:text-my-primary"
                    >
                      <X size={12} />
                    </button>
                  ) : (
                    <span className="my-chip bg-my-layer-1 text-my-tertiary">当前项目</span>
                  )}
                </div>
              )
            })}
          </div>

          <h3 className="mb-1 text-my-xs font-medium text-my-tertiary">运行列表（最近优先）</h3>
          {runs.length === 0 && <p className="mb-2 text-my-sm text-my-tertiary">暂无运行。面板外的终端进程不会出现在这里，也不受"全部停止"影响。</p>}
          <ul className="mb-3 max-h-56 space-y-1 overflow-y-auto my-scrollbar">
            {runs.map((r) => (
              <li key={r.id}>
                <div
                  className={clsx(
                    'flex flex-wrap items-center gap-2 rounded-my-md px-2 py-1.5 hover:bg-my-layer-transparent-hover',
                    selectedRunId === r.id && 'bg-my-layer-transparent-selected'
                  )}
                >
                  <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => { setSelectedRunId(r.id); setFollow(true) }}>
                    <span className="text-my-sm text-my-secondary">{dirName(r.dir)}</span>
                    <span className="ml-2 font-mono text-my-xs text-my-tertiary">{r.command}</span>
                  </button>
                  <span className={clsx('my-chip shrink-0',
                    r.state === 'running' ? 'bg-my-accent-subtle text-my-accent-text' : r.state === 'failed' ? 'bg-my-danger-subtle text-my-danger-text' : 'bg-my-layer-1 text-my-tertiary')}>
                    {RUN_STATE_LABELS[r.state]}{r.state !== 'running' && r.exitCode !== null ? ` · 退出码 ${r.exitCode}` : ''}
                  </span>
                  <span className="shrink-0 text-my-xs text-my-tertiary">{relTime(r.startedAt)}</span>
                  {r.state === 'running' && (
                    <Button variant="ghost" size="sm" className="justify-center px-2" onClick={() => void stop(r.id)} title={`停止 ${r.command}（仅面板自己启动的进程树）`}>
                      <Square size={11} />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {selectedRun && <RunConsole run={selectedRun} follow={follow} onToggleFollow={setFollow} />}
        </>
      )}
    </section>
  )
}

/* ---------------- 页面 ---------------- */

export function DevToolsPage(): JSX.Element {
  const root = useApp((s) => s.snapshot?.meta.root ?? null)
  const rootKey = projectRootKey(root)
  const toolView = useMy((state) => state.toolView)
  return (
    <div key={rootKey ?? 'preview'} className="space-y-4">
      {toolView === 'run' ? <RunSection /> : <GitSection />}
    </div>
  )
}
