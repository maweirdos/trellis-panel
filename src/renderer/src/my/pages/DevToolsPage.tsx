// 本机开发工具（C1/C2/C3）：当前工程只读 Git（状态/基线/差异，无任何写操作）
// 与当前项目的应用启动配置、进程状态及运行输出。
// 诚实边界：进程存活 ≠ 服务就绪；无 Git / 无桥接时中性降级，不伪装能力。
import { useCallback, useEffect, useState, type JSX } from 'react'
import { clsx } from 'clsx'
import { Loader2, RefreshCw, X } from 'lucide-react'
import { api, hasIpc } from '../../api'
import { useApp } from '../../store'
import { useMy } from '../store'
import { projectRootKey } from '../navigation'
import { Button } from '../ui'
import { ApplicationRuntimeView } from '../../applications/ApplicationPanel'
import type { GitReadonlyFileDiff, GitReadonlyStatus } from '@shared/types'

const STATUS_LABELS: Record<string, string> = {
  M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', T: '类型变更', U: '冲突未合', X: '未知', ' ': '无变更'
}
const codeLabel = (c: string): string => STATUS_LABELS[c] ?? c

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

/* ---------------- 页面 ---------------- */

export function DevToolsPage(): JSX.Element {
  const root = useApp((s) => s.snapshot?.meta.root ?? null)
  const rootKey = projectRootKey(root)
  const toolView = useMy((state) => state.toolView)
  return (
    <div key={rootKey ?? 'preview'} className="space-y-4">
      {toolView === 'run' ? <ApplicationRuntimeView /> : <GitSection />}
    </div>
  )
}
