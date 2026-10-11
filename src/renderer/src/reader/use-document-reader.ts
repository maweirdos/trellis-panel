import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import { registerDocumentSession } from './document-session-hub'
import { readingSessionKey } from './reading-session'
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
  mode: ReaderDiffMode
  loading: boolean
  /** ok:false（请求级失败）或降级诊断都原样保留，由 UI 呈现。 */
  outcome: DocumentDiffOutcome | null
}

export interface UseDocumentReaderParams {
  workspaceId: string
  taskRef?: string
  /** 项目根相对路径（正/反斜杠由服务端归一）；null = 走 legacy 绝对路径降级。 */
  relativePath: string | null
  /** legacy 降级读取的绝对路径（relativePath=null 时使用）。 */
  absolutePath?: string | null
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
  const { workspaceId, taskRef, relativePath, absolutePath = null } = params
  const legacy = relativePath === null

  const key = relativePath !== null ? readingSessionKey({ workspaceId, taskRef }, relativePath) : null

  const [loadSeq, setLoadSeq] = useState(0)
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
      setLoading(true)
      api
        .readTextFile(absolutePath)
        .then((res) => {
          if (!alive) return
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
          if (alive) {
            setLoading(false)
            setRequestError('读取失败')
          }
        })
      return () => {
        alive = false
      }
    }

    let alive = true
    let unregisterHub: (() => void) | null = null
    let watchedCanonical: string | null = null
    // 此分支 relativePath 必为 string；key 在此处必然非空（与 relativePath 同源推导）
    const sessionKey = readingSessionKey({ workspaceId, taskRef }, relativePath)
    reqSeq.current += 1
    const baseReqId = `${sessionKey}#${reqSeq.current}`

    setLoading(true)
    setRequestError(null)
    setUnreadableNotice(null)

    /** 消费一次定向变更信号（revision hint 为 null 时总是重读以取得诚实诊断）。 */
    const consumeChange = (revisionHint: string | null): void => {
      if (!alive) return
      void (async () => {
        const cur = useApp.getState().readingSessions[sessionKey]
        if (
          revisionHint !== null &&
          cur !== undefined &&
          cur.displayed !== null &&
          revisionHint === cur.displayed.revision
        ) {
          // 同版信号：只清提示（写回了相同内容），不重读
          if (cur.latest !== null) {
            useApp.getState().readerExternalChange(sessionKey, { revision: revisionHint, text: cur.displayed.text })
          }
          return
        }
        const res = await api.documentRead({ workspaceId, taskRef }, { relativePath, requestId: `${baseReqId}-c` })
        if (!alive) return
        if (!res.ok) {
          // 请求级失败：保留旧版 + 提示（不吞成文档事实）
          setRequestError(res.error)
          return
        }
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
      })()
    }

    void (async () => {
      const res = await api.documentRead({ workspaceId, taskRef }, { relativePath, requestId: baseReqId })
      if (!alive) return
      setLoading(false)
      if (!res.ok) {
        setDoc(null)
        setRequestError(res.error)
        return
      }
      setDoc(res)
      if (res.revision !== null && res.rawText !== null) {
        useApp.getState().readerOpenSession(sessionKey, { revision: res.revision, text: res.rawText })
      }
      // 定向监听：canonicalPath 来自读取结果；knownRevision 闭合「读完→注册」竞态
      const canonical = res.source.canonicalPath
      unregisterHub = registerDocumentSession(sessionKey, canonical, (ev) => consumeChange(ev.revision))
      watchedCanonical = canonical
      void api
        .documentWatch({ workspaceId, taskRef }, { relativePath, knownRevision: res.revision })
        .catch(() => undefined)
    })()

    return () => {
      alive = false
      unregisterHub?.()
      if (watchedCanonical !== null) void api.documentUnwatch(watchedCanonical).catch(() => undefined)
      // 会话收口（known-issues P3-4）：文档关闭/切换即丢弃快照
      useApp.getState().readerCloseSession(sessionKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, taskRef, relativePath, loadSeq])

  const openDiff = useCallback(
    (mode: ReaderDiffMode) => {
      if (relativePath === null || key === null) return
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
      const requestId = `${key}#diff${reqSeq.current}`
      void (async () => {
        try {
          const outcome = await api.documentDiff(
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
          setDiff((d) => (d !== null ? { ...d, loading: false, outcome } : d))
        } catch {
          setDiff((d) => (d !== null ? { ...d, loading: false } : d))
        }
      })()
    },
    [workspaceId, taskRef, relativePath, key]
  )

  const closeDiff = useCallback(() => setDiff(null), [])

  const applyNewVersion = useCallback(async (): Promise<boolean> => {
    if (relativePath === null || key === null) return false
    const res = await api.documentRead({ workspaceId, taskRef }, { relativePath, requestId: `${key}#apply` })
    if (!res.ok) {
      setRequestError(res.error)
      return false
    }
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
    return true
  }, [workspaceId, taskRef, relativePath, key])

  const rebaseToCurrent = useCallback(() => {
    if (key === null) return
    useApp.getState().readerRebaseToCurrent(key)
  }, [key])

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
      requestAnimationFrame(() => applyScrollPlan(container, plan))
      return { fallback: plan.fallbackUsed }
    },
    [applyNewVersion, key]
  )

  const reload = useCallback(() => setLoadSeq((n) => n + 1), [])

  const displayedText = session?.displayed?.text ?? doc?.rawText ?? legacyText
  const displayedRevisionInSession = session?.displayed?.revision ?? null
  const displayedParsed =
    doc !== null && displayedRevisionInSession !== null && doc.revision === displayedRevisionInSession
      ? doc.parsed
      : null
  const diagnostics = doc?.diagnostics ?? []

  return {
    key,
    legacy,
    loading,
    doc,
    requestError,
    unreadableNotice,
    session,
    pendingUpdate,
    displayedText,
    displayedParsed,
    diagnostics,
    diff,
    openDiff,
    closeDiff,
    applyNewVersion,
    applyNewVersionAnchored,
    rebaseToCurrent,
    reload
  }
}
