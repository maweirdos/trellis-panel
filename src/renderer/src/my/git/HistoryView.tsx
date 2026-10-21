import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { clsx } from 'clsx'
import { Loader2, RefreshCw } from 'lucide-react'
import { GIT_HISTORY_LIMIT, type GitHistoryResult, type GitCommitResult, type GitCommitDiffResult } from '@shared/git-readonly'
import { IpcErrorCode } from '@shared/ipc-errors'
import { api } from '../../api'
import { projectRootKey } from '../navigation'
import { Button } from '../ui'
import { HistoryGraph } from './HistoryGraph'
import { UnifiedDiff } from './UnifiedDiff'
import { codeLabel } from './WorkspaceView'

type HistoryPage = Extract<GitHistoryResult, { ok: true }>
type CommitDetail = Extract<GitCommitResult, { ok: true }>
type CommitDiff = Extract<GitCommitDiffResult, { ok: true }>

function matchesRoot(root: string, received: string): boolean {
  return projectRootKey(root) === projectRootKey(received)
}

function CommitFileDiff({ root, hash, path }: { root: string; hash: string; path: string }): JSX.Element {
  const [diff, setDiff] = useState<CommitDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let isCurrent = true
    void (async (): Promise<void> => {
      try {
        const result = await api.devtoolsGitCommitDiff({ expectedRoot: root, hash, path })
        if (!isCurrent) return
        if (result.ok === false) setError(result.error)
        else if (!matchesRoot(root, result.root) || result.path !== path) setError('差异响应与当前项目或文件不匹配，请刷新历史。')
        else setDiff(result)
      } catch (cause) {
        if (isCurrent) setError(cause instanceof Error ? cause.message : '差异读取失败')
      }
    })()
    return () => { isCurrent = false }
  }, [root, hash, path])
  return <div className="min-w-0" aria-label={`提交文件差异 ${path}`}>
    <h4 className="mb-2 break-all font-mono text-my-xs text-my-secondary">{path}</h4>
    {!diff && !error && <p className="text-my-sm text-my-tertiary" role="status">差异生成中…</p>}
    {error && <p className="my-git-notice text-my-warning-text" role="alert">{error}</p>}
    {diff && <UnifiedDiff value={diff} />}
  </div>
}

function CommitDetails({ root, hash }: { root: string; hash: string }): JSX.Element {
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let isCurrent = true
    void (async (): Promise<void> => {
      try {
        const result = await api.devtoolsGitCommit({ expectedRoot: root, hash })
        if (!isCurrent) return
        if (result.ok === false) setError(result.error)
        else if (!matchesRoot(root, result.root) || result.commit.hash !== hash) setError('提交响应与当前项目或选择不匹配，请刷新历史。')
        else {
          setDetail(result)
          setPath(result.files[0]?.path ?? null)
        }
      } catch (cause) {
        if (isCurrent) setError(cause instanceof Error ? cause.message : '提交读取失败')
      }
    })()
    return () => { isCurrent = false }
  }, [root, hash])
  return <div className="my-git-details" aria-label="提交详情">
    {!detail && !error && <p className="text-my-sm text-my-tertiary" role="status">读取提交文件…</p>}
    {error && <p className="my-git-notice text-my-warning-text" role="alert">{error}</p>}
    {detail && <>
      <h3 className="break-words text-my-sm font-medium text-my-primary">{detail.commit.subject || '（无提交说明）'}</h3>
      <p className="mt-1 break-all font-mono text-my-xs text-my-secondary">{detail.commit.hash}</p>
      <p className="mt-1 text-my-xs text-my-tertiary">{detail.commit.author} · {new Date(detail.commit.timestamp).toLocaleString()}</p>
      <p className="my-2 break-words text-my-xs text-my-tertiary">
        {detail.parent === null ? '根提交 · 与空树比较' : detail.commit.parents.length > 1 ? `合并提交 · 仅与第一父提交 ${detail.parent.slice(0, 8)} 比较` : `与父提交 ${detail.parent.slice(0, 8)} 比较`}
      </p>
      {detail.filesTruncated && <p className="my-git-notice text-my-warning-text" role="status">文件列表达到读取上限，仅显示部分改动文件。</p>}
      {detail.files.length === 0 ? <p className="text-my-sm text-my-tertiary">此比较下无文件改动。</p> : <div className="my-git-detail-panes">
        <div className="min-w-0">
          <h4 className="mb-1 text-my-xs text-my-tertiary">改动文件（{detail.files.length}{detail.filesTruncated ? '+' : ''}）</h4>
          <ul className="my-git-commit-files my-scrollbar">
            {detail.files.map((file) => <li key={file.path}>
              <button type="button" className={clsx('my-git-file', file.path === path && 'my-git-selected')} aria-pressed={file.path === path} onClick={() => setPath(file.path)}
                title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                <span className="shrink-0 text-my-xs text-my-tertiary">{codeLabel(file.status)}</span>
                <span className="min-w-0 flex-1 truncate text-left font-mono text-my-xs text-my-secondary">{file.oldPath ? `${file.oldPath} → ` : ''}{file.path}</span>
              </button>
            </li>)}
          </ul>
        </div>
        {path && <CommitFileDiff key={path} root={root} hash={hash} path={path} />}
      </div>}
    </>}
  </div>
}

export function HistoryView({ root }: { root: string }): JSX.Element {
  const [history, setHistory] = useState<HistoryPage | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const requestGeneration = useRef(0)

  const readPage = useCallback(async (previous: HistoryPage | null = null): Promise<void> => {
    const request = ++requestGeneration.current
    setIsLoading(true)
    setError(null)
    try {
      const result = await api.devtoolsGitHistory({ expectedRoot: root, ...(previous ? { offset: previous.nextOffset, revision: previous.revision } : {}) })
      if (requestGeneration.current !== request) return
      if (result.ok === false) {
        if (result.code === IpcErrorCode.Conflict) {
          setHistory(null)
          setSelected(null)
          setError(`${result.error} 请刷新历史后重新读取。`)
        } else setError(result.error)
        return
      }
      if (!matchesRoot(root, result.root) || (previous && result.revision !== previous.revision)) {
        setHistory(null)
        setSelected(null)
        setError('项目或历史已变化，已清除旧分页；请刷新历史。')
        return
      }
      // Defense in depth: never render more than the shared total bound.
      const commits = [...(previous?.commits ?? []), ...result.commits].slice(0, GIT_HISTORY_LIMIT)
      const hashes = new Set<string>()
      if (commits.some((commit) => { const duplicate = hashes.has(commit.hash); hashes.add(commit.hash); return duplicate })) {
        setHistory(null)
        setSelected(null)
        setError('历史分页包含重复提交，请刷新历史。')
        return
      }
      setHistory({ ...result, commits, hasMore: result.hasMore && commits.length < GIT_HISTORY_LIMIT,
        limited: result.limited || (result.hasMore && commits.length >= GIT_HISTORY_LIMIT) })
      setSelected((current) => current && hashes.has(current) ? current : commits[0]?.hash ?? null)
      if (!previous) setRefreshGeneration((generation) => generation + 1)
    } catch (cause) {
      if (requestGeneration.current === request) setError(cause instanceof Error ? cause.message : '历史读取失败')
    } finally {
      if (requestGeneration.current === request) setIsLoading(false)
    }
  }, [root])

  useEffect(() => {
    void readPage()
    return () => { ++requestGeneration.current }
  }, [readPage])

  return <div aria-label="历史" aria-busy={isLoading}>
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <p className="text-my-xs text-my-tertiary">{history ? `已加载 ${history.commits.length} 条提交 · 虚线表示父提交尚未加载` : '本地提交历史与本地 refs'}；手动刷新</p>
      <Button variant="ghost" size="sm" className="ml-auto" disabled={isLoading} onClick={() => void readPage()} aria-label="刷新历史">
        {isLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}刷新
      </Button>
    </div>
    {error && <p className="my-git-notice text-my-warning-text" role="alert">{error}</p>}
    {!history && isLoading && <p className="text-my-sm text-my-tertiary" role="status">读取提交历史…</p>}
    {history && history.commits.length === 0 && <p className="my-git-notice text-my-secondary">当前仓库尚无提交。</p>}
    {history && history.commits.length > 0 && <>
      <HistoryGraph key={refreshGeneration} commits={history.commits} refs={history.refs} head={history.head} selected={selected} onSelect={setSelected} />
      <div className="my-2 flex flex-wrap items-center gap-2">
        {history.hasMore && <Button size="sm" variant="outline" disabled={isLoading} onClick={() => void readPage(history)}>{isLoading ? '读取中…' : '加载更多'}</Button>}
        {history.limited && <p className="text-my-xs text-my-tertiary">已达 {GIT_HISTORY_LIMIT.toLocaleString()} 条上限，较早历史未加载。</p>}
        {!history.hasMore && !history.limited && <p className="text-my-xs text-my-tertiary">已显示全部本地历史。</p>}
      </div>
      {selected && <CommitDetails key={`${refreshGeneration}:${selected}`} root={root} hash={selected} />}
    </>}
  </div>
}
