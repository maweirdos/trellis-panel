import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import { registerDocumentSession } from './document-session-hub'
import { readingOwnerKey, ReaderRequestOwner } from './reader-owner'
import { projectRootKey } from '../my/navigation'
import { relativePathUnderRoot } from './reader-paths'
import { applyScrollPlan, captureScrollPosition, resolveScrollRestore } from './scroll-restore'
import type { ReadingSessionState } from './reading-session'
import type {
  DocumentDiagnostic,
  DocumentDiffOutcome,
  DocumentParsed,
  DocumentReadSuccess
} from '../../../shared/documents'

/**
 * useDocumentReader（S0 G2 第三片）：三入口共用的加载/错误/版本契约。
 *
 * - 加载走 documentRead（revision/诊断契约）；首次成功装载建立阅读会话基线
 *   （readerOpenSession），此后正文展示版只来自会话状态机（displayed）。
 * - 外部变化：注册 document:watch 定向监听（knownRevision 闭合注册竞态），
 *   事件按 canonicalPath 派发到本会话 → 重读一次 → externalChangeDetected
 *   只标记 latest——展示版/选区不动，顶部出「发现新版本」提示（AC2）。
 * - 「阅读新版」才替换 displayed（readNewVersion + 重读装载新载荷）。
 * - 读取失败（请求级/文档级）保留旧版并提示；缺失→成功的变化补建会话基线。
 * - 卸载/切换文档：readerCloseSession + 解除监听（known-issues P3-4 收口）。
 * - relativePath=null（项目外文件）降级为旧 readTextFile：无会话、无版本比较，
 *   能力差异如实可见，不伪装在项目内。
 */

export type ReaderDiffMode = 'pending' | 'git-latest-commit'

export interface ReaderDiffState {
  mode: ReaderDiffMode | 'selected-versions'
  comparisonLabels?: { left: string; right: string }
  loading: boolean
  /** ok:false（请求级失败）或降级诊断都原样保留，由 UI 呈现。 */
  outcome: DocumentDiffOutcome | null
}

export type DocumentReaderTransport = Pick<typeof api, 'documentRead' | 'documentWatch' | 'documentDiff'> & {
  documentUnwatch: (canonicalPath: string, watchId: string) => Promise<void>
}

export interface UseDocumentReaderParams {
  workspaceId: string
  taskRef?: string
  /** 项目根相对路径（正/反斜杠由服务端归一）；null = 走 legacy 绝对路径降级。 */
  relativePath: string | null
  /** legacy 降级读取的绝对路径（relativePath=null 时使用）。 */
  absolutePath?: string | null
  /** Explicit root for scoped hosts; workspaceId is only a namespace. */
  projectRoot?: string
  /** Sender-bound native transport, retaining the same reading state machine. */
  transport?: DocumentReaderTransport
  /** Verified immutable main-process version; current reads become candidates. */
  initialDocument?: DocumentReadSuccess
}

export interface DocumentReaderController {
  /** 会话键（legacy 降级为 null）。 */
  key: string | null
  legacy: boolean
  loading: boolean
  /** 展示版 documentRead 载荷（legacy 为 null）。 */
  doc: DocumentReadSuccess | null
  requestError: string | null
  /** 外部候选读取失败/不可读的提示（保留旧版时的诚实说明）。 */
  unreadableNotice: string | null
  session: ReadingSessionState | undefined
  pendingUpdate: boolean
  /** 展示版全文（会话 displayed；缺失/超限/legacy 按各自来源）。 */
  displayedText: string | null
  /** 展示版的结构化解析（载荷与展示版同版时才提供，否则 null）。 */
  displayedParsed: DocumentParsed | null
  diagnostics: DocumentDiagnostic[]
  diff: ReaderDiffState | null
  openDiff: (mode: ReaderDiffMode) => void
  closeDiff: () => void
  /** 「阅读新版」：重读→displayed := 最新；成功返回 true。 */
  applyNewVersion: () => Promise<boolean>
  /**
   * 「阅读新版」+ 锚点恢复（design §6.2）：应用新版后按稳定标题锚点+段内偏移
   * 恢复滚动；锚点消失回退最近存活章节（fallback=true，调用方提示）。
   * 返回 null = 未执行（无容器/应用失败）。
   */
  applyNewVersionAnchored: (container: HTMLElement | null) => Promise<{ fallback: boolean } | null>
  rebaseToCurrent: () => void
  reload: () => void
}

export function useDocumentReader(params: UseDocumentReaderParams): DocumentReaderController {
  const { workspaceId, taskRef, relativePath, absolutePath = null, projectRoot, transport = api, initialDocument } = params
  const legacy = relativePath === null
  const ownerId = useId()
  const key = relativePath !== null ? readingOwnerKey({ workspaceId, taskRef }, relativePath, ownerId) : null
  const identity = JSON.stringify([key, absolutePath, projectRoot])
  const identityRef = useRef(identity)
  const requests = useRef(new ReaderRequestOwner())
  if (identityRef.current !== identity) {
    identityRef.current = identity
    requests.current.invalidate()
  }
  const hasCurrentRoot = useCallback((): boolean => projectRoot === undefined ||
    projectRootKey(useApp.getState().snapshot?.meta.root ?? '') === projectRootKey(projectRoot), [projectRoot])
  const acceptsSource = useCallback((res: DocumentReadSuccess): boolean =>
    res.source.relativePath === relativePath?.replace(/\\/g, '/') && res.source.workspaceId === workspaceId &&
    (res.source.taskRef ?? undefined) === taskRef &&
    (projectRoot === undefined || relativePathUnderRoot(projectRoot, res.source.canonicalPath) !== null),
  [projectRoot, relativePath, workspaceId, taskRef])

  const refreshRef = useRef<(() => void) | null>(null)
  const [loadedIdentity, setLoadedIdentity] = useState(identity)
  const [loading, setLoading] = useState(!legacy)
  const [doc, setDoc] = useState<DocumentReadSuccess | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [unreadableNotice, setUnreadableNotice] = useState<string | null>(null)
  const [legacyText, setLegacyText] = useState<string | null>(null)
  const [diff, setDiff] = useState<ReaderDiffState | null>(null)
  const reqSeq = useRef(0)

  const session = useApp((s) => (key !== null ? s.readingSessions[key] : undefined))
  const pendingUpdate =
    session !== undefined && session.latest !== null && session.displayed !== null && session.latest.revision !== session.displayed.revision

  useEffect(() => {
    setLoadedIdentity(identity)
    setDiff(null)
    setDoc(null)
    setLegacyText(null)
    if (relativePath === null) {
      // legacy 降级：项目外文件走旧读取路径（无会话/无版本比较）
      setDoc(null)
      setRequestError(null)
      setUnreadableNotice(null)
      if (absolutePath === null || absolutePath === '') {
        setLegacyText(null)
        setLoading(false)
        return
      }
      let alive = true
      const readLegacy = (): void => {
        const ticket = requests.current.request('legacy')
        setLoading(true)
        void api.readTextFile(absolutePath)
        .then((res) => {
          if (!alive || !requests.current.accepts(ticket)) return
          setLoading(false)
          if (res.ok) {
            setLegacyText(res.content ?? '')
            setRequestError(null)
          } else {
            setLegacyText(null)
            setRequestError(res.error ?? '读取失败')
          }
        })
        .catch(() => {
          if (alive && requests.current.accepts(ticket)) {
            setLoading(false)
            setRequestError('读取失败')
          }
        })
      }
      refreshRef.current = readLegacy
      readLegacy()
      return () => {
        alive = false
        requests.current.invalidate()
        refreshRef.current = null
      }
    }

    let alive = true
    let unregisterHub: (() => void) | null = null
    let watchLease: { canonicalPath: string; watchId: string } | null = null
    const releasedWatchIds = new Set<string>()
    const releaseWatch = (lease: { canonicalPath: string; watchId: string }): void => {
      if (releasedWatchIds.has(lease.watchId)) return
      releasedWatchIds.add(lease.watchId)
      // A canonical path may already belong to a newer A -> B -> A registration.
      // Only the acknowledged opaque registration may be released, never its path alone.
      void transport.documentUnwatch(lease.canonicalPath, lease.watchId).catch(() => undefined)
    }
    // 此分支 relativePath 必为 string；key 在此处必然非空（与 relativePath 同源推导）
    const sessionKey = readingOwnerKey({ workspaceId, taskRef }, relativePath, ownerId)
    reqSeq.current += 1
    const baseReqId = `${ownerId}#${reqSeq.current}`

    setLoading(true)
    setRequestError(null)
    setUnreadableNotice(null)

    let watchPending = false
    const ensureWatch = (res: DocumentReadSuccess): void => {
      if (watchPending || watchLease !== null || !alive) return
      watchPending = true
      const canonical = res.source.canonicalPath
      unregisterHub?.()
      unregisterHub = registerDocumentSession(sessionKey, canonical, () => consumeChange())
      void transport.documentWatch({ workspaceId, taskRef }, { relativePath, knownRevision: res.revision }).then((watched) => {
        if (watched.ok) {
          if (typeof watched.watchId !== 'string' || watched.watchId === '') {
            if (alive && hasCurrentRoot()) setRequestError('文档监听未返回有效的注册标识，请重试')
            return
          }
          const lease = { canonicalPath: watched.canonicalPath, watchId: watched.watchId }
          if (!alive || !hasCurrentRoot()) releaseWatch(lease)
          else watchLease = lease
        } else if (alive && hasCurrentRoot()) setRequestError(watched.error)
      }).catch((error: unknown) => {
        if (alive && hasCurrentRoot()) setRequestError(error instanceof Error ? error.message : '文档监听失败，可重试')
      }).finally(() => { watchPending = false })
    }

    /** Re-read actual bytes; hints never authorize replacing the displayed version. */
    const consumeChange = (): void => {
      if (!alive || !hasCurrentRoot()) return
      const ticket = requests.current.request('read')
      void (async () => {
        const res = await transport.documentRead({ workspaceId, taskRef }, { relativePath, requestId: `${baseReqId}-c${ticket.sequence}` })
        if (!alive || !hasCurrentRoot() || !requests.current.accepts(ticket)) return
        setLoading(false)
        if (!res.ok) {
          // 请求级失败：保留旧版 + 提示（不吞成文档事实）
          setRequestError(res.error)
          return
        }
        if (!acceptsSource(res)) { setRequestError('文档来源与当前项目不一致'); return }
        setRequestError(null)
        setUnreadableNotice(null)
        ensureWatch(res)
        if (res.revision !== null && res.rawText !== null) {
          const cur2 = useApp.getState().readingSessions[sessionKey]
          if (cur2 === undefined || cur2.displayed === null) {
            // 此前缺失/未建立会话：这次成功读取即首次装载（建立基线）
            useApp.getState().readerOpenSession(sessionKey, { revision: res.revision, text: res.rawText })
            setDoc(res)
          } else {
            // 只标记 latest：展示版与选区不动（AC2 连续保存不重置阅读）
            useApp.getState().readerExternalChange(sessionKey, { revision: res.revision, text: res.rawText })
          }
        } else {
          // 文档级事实（缺失/暂不可读/超限）：保留旧版并如实提示
          const first = res.diagnostics[0]
          setUnreadableNotice(first !== undefined ? first.message : '文件暂不可读，已保留当前展示版本')
        }
      })().catch((error: unknown) => {
        if (alive && hasCurrentRoot() && requests.current.accepts(ticket)) {
          setLoading(false)
          setRequestError(error instanceof Error ? error.message : '读取失败')
        }
      })
    }

    refreshRef.current = consumeChange
    const seeded = initialDocument !== undefined && acceptsSource(initialDocument) && initialDocument.rawText !== null && initialDocument.revision !== null
    if (seeded) {
      setDoc(initialDocument)
      useApp.getState().readerOpenSession(sessionKey, { revision: initialDocument.revision as string, text: initialDocument.rawText as string })
      setLoading(false)
      ensureWatch(initialDocument)
    }
    const ticket = requests.current.request('read')
    void (async () => {
      if (!hasCurrentRoot()) { setLoading(false); setRequestError('项目已切换，请返回原项目阅读此文档'); return }
      const res = await transport.documentRead({ workspaceId, taskRef }, { relativePath, requestId: baseReqId })
      if (!alive || !hasCurrentRoot() || !requests.current.accepts(ticket)) return
      setLoading(false)
      if (!res.ok) {
        if (!seeded) setDoc(null)
        setRequestError(res.error)
        return
      }
      if (!acceptsSource(res)) { setRequestError('文档来源与当前项目不一致'); return }
      if (!seeded) setDoc(res)
      if (res.revision !== null && res.rawText !== null) {
        if (seeded) useApp.getState().readerExternalChange(sessionKey, { revision: res.revision, text: res.rawText })
        else useApp.getState().readerOpenSession(sessionKey, { revision: res.revision, text: res.rawText })
      } else if (seeded) {
        setUnreadableNotice(res.diagnostics[0]?.message ?? '文件暂不可读，已保留固定版本')
      }
      // 定向监听：canonicalPath 来自读取结果；knownRevision 闭合「读完→注册」竞态
      ensureWatch(res)
    })().catch((error: unknown) => {
      if (alive && hasCurrentRoot() && requests.current.accepts(ticket)) {
        setLoading(false)
        setRequestError(error instanceof Error ? error.message : '读取失败')
      }
    })

    return () => {
      alive = false
      requests.current.invalidate()
      refreshRef.current = null
      unregisterHub?.()
      if (watchLease !== null) releaseWatch(watchLease)
      // 会话收口（known-issues P3-4）：文档关闭/切换即丢弃快照
      useApp.getState().readerCloseSession(sessionKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, taskRef, relativePath, absolutePath, ownerId, identity, hasCurrentRoot, acceptsSource, transport, initialDocument])

  const openDiff = useCallback(
    (mode: ReaderDiffMode) => {
      if (relativePath === null || key === null || !hasCurrentRoot()) return
      const s = useApp.getState().readingSessions[key]
      if (s === undefined || s.displayed === null) return
      if (mode === 'pending' && s.latest === null) return
      // pending：基准=当前展示版 → 最新候选；git：基准=最近提交（HEAD）→ 当前展示版。
      // 两种基准的文案由 UI 说清（语义红线：提示文案说清比较基准）。
      const displayed = s.displayed
      const currentSide = mode === 'pending' ? s.latest : displayed
      if (currentSide === null) return
      setDiff({ mode, loading: true, outcome: null })
      reqSeq.current += 1
      const ticket = requests.current.request('diff')
      const requestId = `${ownerId}:diff:${ticket.sequence}`
      void (async () => {
        try {
          const outcome = await transport.documentDiff(
            { workspaceId, taskRef },
            {
              requestId,
              relativePath,
              baseline:
                mode === 'pending'
                  ? {
                      kind: 'text',
                      side: { text: displayed.text, revision: displayed.revision }
                    }
                  : { kind: 'git-latest-commit' },
              current: { text: currentSide.text, revision: currentSide.revision }
            }
          )
          if (identityRef.current === identity && hasCurrentRoot() && requests.current.accepts(ticket)) {
            setDiff((d) => (d !== null ? { ...d, loading: false, outcome } : d))
          }
        } catch {
          if (identityRef.current === identity && hasCurrentRoot() && requests.current.accepts(ticket)) {
            setDiff(null)
            setRequestError('文档比较失败，已保留当前内容，可重试')
          }
        }
      })()
    },
    [workspaceId, taskRef, relativePath, key, identity, ownerId, hasCurrentRoot, transport]
  )

  const closeDiff = useCallback(() => { requests.current.request('diff'); setDiff(null) }, [])

  const applyNewVersion = useCallback(async (): Promise<boolean> => {
    if (relativePath === null || key === null || !hasCurrentRoot()) return false
    // File-change reads and explicit replacements share ordering. A newer observation
    // must not be overwritten by an older apply completion.
    const ticket = requests.current.request('read')
    let res: Awaited<ReturnType<typeof api.documentRead>>
    try {
      res = await transport.documentRead({ workspaceId, taskRef }, { relativePath, requestId: `${ownerId}:apply:${ticket.sequence}` })
    } catch (error) {
      if (identityRef.current === identity && hasCurrentRoot() && requests.current.accepts(ticket)) setRequestError(error instanceof Error ? error.message : '读取失败')
      return false
    }
    if (identityRef.current !== identity || !hasCurrentRoot() || !requests.current.accepts(ticket)) return false
    if (!res.ok) {
      setRequestError(res.error)
      return false
    }
    if (!acceptsSource(res)) { setRequestError('文档来源与当前项目不一致'); return false }
    if (res.revision === null || res.rawText === null) {
      const first = res.diagnostics[0]
      setUnreadableNotice(first !== undefined ? first.message : '文件暂不可读，已保留当前展示版本')
      return false
    }
    const st = useApp.getState()
    if (st.readingSessions[key] === undefined) return false
    // 先把候选刷新为刚读到的版本，再交给状态机替换 displayed（不触碰首次基线）
    st.readerExternalChange(key, { revision: res.revision, text: res.rawText })
    st.readerReadNewVersion(key)
    setDoc(res)
    setRequestError(null)
    setUnreadableNotice(null)
    closeDiff()
    return true
  }, [workspaceId, taskRef, relativePath, key, identity, ownerId, hasCurrentRoot, acceptsSource, closeDiff, transport])

  const rebaseToCurrent = useCallback(() => {
    if (key === null || !hasCurrentRoot()) return
    useApp.getState().readerRebaseToCurrent(key)
  }, [key, hasCurrentRoot])

  const applyNewVersionAnchored = useCallback(
    async (container: HTMLElement | null): Promise<{ fallback: boolean } | null> => {
      if (container === null || key === null) return null
      const captured = captureScrollPosition(container)
      const oldText = useApp.getState().readingSessions[key]?.displayed?.text ?? null
      const ok = await applyNewVersion()
      if (!ok) return null
      const newText = useApp.getState().readingSessions[key]?.displayed?.text ?? null
      if (oldText === null || newText === null) return { fallback: false }
      const plan = resolveScrollRestore({ captured, oldText, newText })
      requestAnimationFrame(() => {
        if (identityRef.current === identity && hasCurrentRoot() && container.isConnected) applyScrollPlan(container, plan)
      })
      return { fallback: plan.fallbackUsed }
    },
    [applyNewVersion, key, identity, hasCurrentRoot]
  )

  const reload = useCallback(() => refreshRef.current?.(), [])

  const visible = loadedIdentity === identity
  const currentDoc = visible ? doc : null
  const displayedText = session?.displayed?.text ?? currentDoc?.rawText ?? (visible ? legacyText : null)
  const displayedRevisionInSession = session?.displayed?.revision ?? null
  const displayedParsed =
    currentDoc !== null && displayedRevisionInSession !== null && currentDoc.revision === displayedRevisionInSession
      ? currentDoc.parsed
      : null
  const diagnostics = currentDoc?.diagnostics ?? []

  return {
    key,
    legacy,
    loading: visible ? loading : true,
    doc: currentDoc,
    requestError: visible ? requestError : null,
    unreadableNotice: visible ? unreadableNotice : null,
    session,
    pendingUpdate,
    displayedText,
    displayedParsed,
    diagnostics,
    diff: visible ? diff : null,
    openDiff,
    closeDiff,
    applyNewVersion,
    applyNewVersionAnchored,
    rebaseToCurrent,
    reload
  }
}
