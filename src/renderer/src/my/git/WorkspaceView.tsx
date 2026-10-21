import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { clsx } from 'clsx'
import { Loader2, RefreshCw, X } from 'lucide-react'
import type { GitReadonlyFileDiff, GitReadonlyStatus } from '@shared/types'
import { api } from '../../api'
import { Button } from '../ui'
import { UnifiedDiff } from './UnifiedDiff'

const STATUS_LABELS: Record<string, string> = {
  M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', T: '类型变更', U: '冲突未合', X: '未知', ' ': '无变更'
}
export const codeLabel = (code: string): string => STATUS_LABELS[code.charAt(0)] ?? code

export function WorkspaceView(): JSX.Element {
  const [status, setStatus] = useState<GitReadonlyStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState<GitReadonlyFileDiff | null>(null)
  const [isDiffLoading, setIsDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const statusRequest = useRef(0)
  const diffRequest = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const request = ++statusRequest.current
    ++diffRequest.current
    setSelected(null)
    setDiff(null)
    setIsDiffLoading(false)
    setDiffError(null)
    setIsLoading(true)
    setError(null)
    try {
      const result = await api.devtoolsGitStatus()
      if (statusRequest.current === request) setStatus(result)
    } catch (cause) {
      if (statusRequest.current === request) setError(cause instanceof Error ? cause.message : '工作区读取失败')
    } finally {
      if (statusRequest.current === request) setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    return () => { ++statusRequest.current; ++diffRequest.current }
  }, [refresh])

  const openDiff = async (path: string, staged: boolean): Promise<void> => {
    const request = ++diffRequest.current
    setSelected({ path, staged })
    setIsDiffLoading(true)
    setDiff(null)
    setDiffError(null)
    try {
      const result = await api.devtoolsGitFileDiff(path, staged)
      if (diffRequest.current === request) {
        if (result.path !== path || result.staged !== staged) setDiffError('差异响应与当前文件不匹配，请刷新后重试。')
        else setDiff(result)
      }
    } catch (cause) {
      if (diffRequest.current === request) setDiffError(cause instanceof Error ? cause.message : '差异读取失败')
    } finally {
      if (diffRequest.current === request) setIsDiffLoading(false)
    }
  }

  const groups = status ? [
    { key: 'staged', title: `暂存区改动（${status.staged.length}）`, staged: true, entries: status.staged.map((e) => ({ path: e.path, note: `${codeLabel(e.x)}${e.origPath ? ` ← ${e.origPath}` : ''}` })) },
    { key: 'unstaged', title: `未暂存改动（${status.unstaged.length}）`, staged: false, entries: status.unstaged.map((e) => ({ path: e.path, note: codeLabel(e.y) })) }
  ] : []

  return (
    <div aria-label="工作区" aria-busy={isLoading}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {status?.ok && status.isRepo && <span className="my-chip text-my-secondary">
          {status.branch ?? (status.head ? '分离 HEAD' : '尚无提交')}{status.head ? ` · 基线 ${status.head.short} ${status.head.subject.slice(0, 40)}` : ''}
        </span>}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void refresh()} disabled={isLoading} aria-label="刷新工作区">
          {isLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}刷新
        </Button>
      </div>
      <p className="mb-3 text-my-xs leading-5 text-my-tertiary">基线为当前 HEAD；已有脏改动可能包含此前未关联的工作，归属以 Git 为准。</p>
      {isLoading && !status && <p className="text-my-sm text-my-tertiary" role="status">读取工作区…</p>}
      {error && <p className="my-git-notice text-my-warning-text" role="alert">{error}</p>}
      {status && (!status.isRepo || !status.ok) && <p className="my-git-notice text-my-secondary" role="status">{status.error ?? (status.isRepo ? 'Git 读取失败' : '当前项目目录不是 Git 仓库')}</p>}
      {status?.ok && status.isRepo && <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        {groups.map((group) => <div key={group.key} className="min-w-0">
          <h3 className="mb-1 text-my-xs font-medium text-my-tertiary">{group.title}</h3>
          {group.entries.length === 0 && <p className="px-1 text-my-sm text-my-tertiary">无</p>}
          <ul className="my-scrollbar max-h-48 overflow-y-auto">
            {group.entries.map((entry) => <li key={entry.path}>
              <button type="button" disabled={isLoading} onClick={() => void openDiff(entry.path, group.staged)}
                aria-pressed={selected?.path === entry.path && selected.staged === group.staged}
                className={clsx('my-git-file', selected?.path === entry.path && selected.staged === group.staged && 'my-git-selected')}>
                <span className="my-chip shrink-0 text-my-tertiary">{group.staged ? '暂存' : '未暂存'}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-my-xs text-my-secondary" title={entry.path}>{entry.path}</span>
                <span className="my-git-file-note text-my-xs text-my-tertiary" title={entry.note}>{entry.note}</span>
              </button>
            </li>)}
          </ul>
        </div>)}
        <div className="min-w-0 lg:col-span-2">
          <h3 className="mb-1 text-my-xs font-medium text-my-tertiary">未跟踪（{status.untracked.length}）</h3>
          {status.untracked.length === 0 && <p className="px-1 text-my-sm text-my-tertiary">无</p>}
          <ul className="my-scrollbar max-h-32 overflow-y-auto">
            {status.untracked.map((path) => <li key={path} className="flex items-baseline gap-2 px-2 py-1">
              <span className="my-chip shrink-0 text-my-tertiary">未跟踪</span>
              <span className="min-w-0 flex-1 truncate font-mono text-my-xs text-my-secondary" title={path}>{path}</span>
              <span className="shrink-0 text-my-xs text-my-tertiary">无基线差异</span>
            </li>)}
          </ul>
        </div>
        {selected && <div className="min-w-0 lg:col-span-2">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate font-mono text-my-xs text-my-secondary" title={selected.path}>
              {selected.path} · {selected.staged ? '与 HEAD 的暂存差异' : '工作区未暂存差异'}
            </h3>
            <Button variant="ghost" size="sm" className="px-2" onClick={() => { ++diffRequest.current; setSelected(null); setDiff(null); setIsDiffLoading(false) }} aria-label="关闭差异"><X size={12} /></Button>
          </div>
          {isDiffLoading && <p className="text-my-sm text-my-tertiary" role="status">差异生成中…</p>}
          {(diffError || (diff && !diff.ok)) && <p className="my-git-notice text-my-warning-text" role="alert">{diffError ?? diff?.error ?? '差异读取失败'}</p>}
          {diff?.ok && !isDiffLoading && <UnifiedDiff value={diff} />}
        </div>}
      </div>}
    </div>
  )
}
