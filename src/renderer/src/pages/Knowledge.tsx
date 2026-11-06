import { rememberVisit } from '../my/personal-history'
import { ModuleLinks } from '../my/layout/ModuleLinks'
import { PageContent, PageSection } from '../my/layout/PageLayout'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  FileText,
  BookOpenText,
  Archive,
  ScrollText,
  RefreshCw,
  ExternalLink,
  Sparkles,
  Loader2,
  Send,
  X,
  Cloud,
  StickyNote,
  Save,
  Trash2,
  History,
  ChevronLeft,
  ChevronRight
} from 'lucide-react'
import { useApp } from '../store'
import { api, hasIpc } from '../api'
import { clsx } from 'clsx'
import { fmtBytes, relTime } from '../utils/format'
import { MarkdownView } from '../components/MarkdownView'
import { DocumentReader } from '../reader/DocumentReader'
import { confirmDialog } from '../components/Dialogs'
import { projectRootKey } from '../my/navigation'
import { relativePathUnderRoot } from '../reader/reader-paths'
import { stageKnowledgeReferenceHandoff } from '../acp/knowledge-reference-handoff'
import { Button, Dropdown, DropdownItem, Modal, SearchInput } from '../my/ui'
import { useMy } from '../my/store'
import { SidebarResizeHandle, useSidebarWidthStyle } from '../my/layout/SidebarResizeHandle'
import { ContextRegion } from '../my/layout/ContextRegion'
import { ProductMaterialActions } from '../knowledge/ProductMaterialActions'
import { useKnowledgeDiscussion } from '../knowledge/discussion-panel'
import { KnowledgeScopeControl } from '../knowledge/KnowledgeScopeControl'
import { KnowledgeSourceView } from '../knowledge/KnowledgeSourceView'
import { KnowledgeBrowser } from '../knowledge/KnowledgeBrowser'
import '../knowledge/KnowledgeBrowser.css'
import { knowledgeBridge, knowledgeError, knowledgeStatusLabel, requireKnowledge, useProjectKnowledge } from '../knowledge/bridge'
import type { KnowledgeCollection, KnowledgeDocument, KnowledgeFolderTree, KnowledgeSource } from '../../../shared/knowledge-access'
import type { KbBrowseSuccess, KbDoc, KbHit, KbLibrary, KbQaEntry, KbSearchResult } from '../../../shared/types'
import type { JSX } from 'react'

type LibFilter = KbLibrary | 'all' | 'company'

/** 公司库文档在浏览态聚合多个 WeKnora 知识库，额外携带来源库名 */
type CompanyDoc = KnowledgeDocument & { kbName: string }

/** 右侧阅读器当前打开的远程（WeKnora）文档 */
interface RemoteDoc {
  knowledgeId: string
  title: string
  fileName: string
  content: string | null
  loading: boolean
  error?: string
  snapshot?: KnowledgeSource
}

/** zustand 选择器兜底用的稳定空数组（每次返回新 [] 会触发 getSnapshot 重渲染问题） */
const NO_KB_IDS: string[] = []
type NoteDraft = { name: string; content: string; isNew: boolean }
// Keep unsaved editor contents in memory, keyed by project, across navigation/unmounts.
const noteDrafts = new Map<string, NoteDraft>()

function localCoverageMessage(result: KbBrowseSuccess): string | null {
  if (result.complete === true) return null
  if (result.complete !== false) return '本地索引覆盖范围未知，请更新桌面应用。'
  const reasons: Record<NonNullable<KbBrowseSuccess['truncationReason']>, string> = {
    entry_limit: '扫描条目达到上限', document_limit: '文档数量达到上限',
    byte_limit: '读取量达到上限', unreadable: '部分目录或文件不可读'
  }
  return `本地索引未覆盖全部资料：${result.truncationReason ? reasons[result.truncationReason] : '原因未知'}`
}

const LIB_META: Record<KbLibrary, { label: string; icon: JSX.Element; desc: string }> = {
  requirements: { label: '需求', icon: <ScrollText size={14} />, desc: '活动任务 PRD 与 task.json 提炼的需求文档' },
  notes: { label: '笔记', icon: <StickyNote size={14} />, desc: '当前项目 .trellis/notes 文件，可新建 / 编辑 / 删除' },
  spec: { label: '规范库', icon: <BookOpenText size={14} />, desc: '.trellis/spec 团队规范（在规范页管理）' },
  wiki: { label: '文档', icon: <FileText size={14} />, desc: 'README / docs / wiki 等仓库文档' },
  archive: { label: '归档', icon: <Archive size={14} />, desc: '已归档任务的沉淀经验' }
}

const LIB_CHIP: Record<KbLibrary, string> = {
  requirements: 'bg-my-label-yellow text-my-label-yellow-text',
  spec: 'bg-my-label-emerald text-my-label-emerald-text',
  wiki: 'bg-my-label-indigo text-my-label-indigo-text',
  notes: 'bg-my-label-orange text-my-label-orange-text',
  archive: 'bg-my-label-purple text-my-label-purple-text'
}

export function KnowledgePage(): JSX.Element {
  const sidebarStyle = useSidebarWidthStyle()
  const sidebarCollapsed = useMy((state) => state.sidebarCollapsed)
  const snapshot = useApp((s) => s.snapshot)
  const pushToast = useApp((s) => s.pushToast)
  const viewerTabs = useApp((s) => s.viewerTabs)
  const openArtifact = useApp((s) => s.openArtifact)
  const setPage = useApp((s) => s.setPage)
  const openSpecDocument = useApp((s) => s.openSpecDocument)

  const knowledgeView = useMy((state) => state.knowledgeView)
  /** 资料视图恒为全库联邦检索（分组树内折叠定位）；知识库视图单独检索 WeKnora */
  const scope: LibFilter = knowledgeView === 'company' ? 'company' : 'all'
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [result, setResult] = useState<KbSearchResult | null>(null)
  const [localResultOwner, setLocalResultOwner] = useState<{ query: string; folder: string; page: number; current: () => boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [scopeOpen, setScopeOpen] = useState(false)
  const [active, setActive] = useState<KbDoc | null>(null)
  const [docContent, setDocContent] = useState<string | null>(null)
  const [docError, setDocError] = useState<string | null>(null)
  const searchSeq = useRef(0)
  const docSeq = useRef(0)
  const pageRef = useRef<HTMLDivElement | null>(null)
  const readerRef = useRef<HTMLDivElement | null>(null)

  /* 公司库（WeKnora）——独立状态与序号，异步追加，绝不阻塞本地检索 */
  const knowledge = useProjectKnowledge(snapshot?.meta.root ?? '')
  const [readerOwner, setReaderOwner] = useState<{ root: string | null; view: typeof knowledgeView; current: () => boolean } | null>(null)
  const readerCurrent = readerOwner?.root === projectRootKey(snapshot?.meta.root) && readerOwner?.view === knowledgeView && readerOwner?.current === knowledge.current && knowledge.current()
  const weknoraEnabled = Boolean(knowledge.context?.scope.connectionId)
  const weknoraKbIds = knowledge.context?.scope.collectionIds ?? NO_KB_IDS
  const [companyHits, setCompanyHits] = useState<KnowledgeSource[]>([])
  const [companyDocs, setCompanyDocs] = useState<CompanyDoc[]>([])
  const [companyLoading, setCompanyLoading] = useState(false)
  const [companyError, setCompanyError] = useState<string | null>(null)
  const [companyPage, setCompanyPage] = useState(1)
  const [companyHasMore, setCompanyHasMore] = useState(false)
  const [companySearchOwner, setCompanySearchOwner] = useState<{ query: string; scopeRevision: string | undefined; current: () => boolean } | null>(null)
  const [companyReadOwner, setCompanyReadOwner] = useState<{ query: string; scopeRevision: string | undefined; current: () => boolean } | null>(null)
  const [companyPageOwner, setCompanyPageOwner] = useState<{ collectionId: string; folder: string | null; page: number; scopeRevision: string | undefined; current: () => boolean } | null>(null)
  const [collectionId, setCollectionId] = useState('')
  const [remoteFolder, setRemoteFolder] = useState<string | null>(null)
  const [remoteTree, setRemoteTree] = useState<KnowledgeFolderTree | null>(null)
  const [remoteTreeError, setRemoteTreeError] = useState<string | null>(null)
  const [treeRefresh, setTreeRefresh] = useState(0)
  const [collections, setCollections] = useState<KnowledgeCollection[]>([])
  const [browseDocs, setBrowseDocs] = useState<KbDoc[]>([])
  const [localFolders, setLocalFolders] = useState<string[]>([])
  const [localBrowseMode, setLocalBrowseMode] = useState<'checking' | 'available' | 'legacy'>('checking')
  const [localFolder, setLocalFolder] = useState('')
  const [localPage, setLocalPage] = useState(1)
  const [localHasMore, setLocalHasMore] = useState(false)
  const localSnapshot = useRef<{ folder: string; current: () => boolean; snapshotAt: number } | null>(null)
  const [localSnapshotNotice, setLocalSnapshotNotice] = useState<{ folder: string; current: () => boolean; message: string } | null>(null)
  const [localCoverage, setLocalCoverage] = useState<string | null>(null)
  const [localRefresh, setLocalRefresh] = useState(0)
  const [localRefreshing, setLocalRefreshing] = useState(false)
  const refreshSeq = useRef(0)
  const [treeVisible, setTreeVisible] = useState(true)
  const [discussionTreeVisible, setDiscussionTreeVisible] = useState(false)
  const discussionOpen = useKnowledgeDiscussion((state) => state.open && state.root === projectRootKey(snapshot?.meta.root))
  useLayoutEffect(() => { setDiscussionTreeVisible(false) }, [discussionOpen])
  const directoryVisible = discussionOpen ? discussionTreeVisible : treeVisible
  const companySeq = useRef(0)
  const [remoteDoc, setRemoteDoc] = useState<RemoteDoc | null>(null)

  /* AI 问答 */
  const aiEnabled = useApp((s) => s.settings?.ai.enabled ?? false)
  const [aiQuestion, setAiQuestion] = useState('')
  const [aiAnswer, setAiAnswer] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiSources, setAiSources] = useState<KbDoc[]>([])
  const [aiRemoteSources, setAiRemoteSources] = useState<KnowledgeSource[]>([])
  const [qaHistory, setQaHistory] = useState<KbQaEntry[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [showLegacyQa, setShowLegacyQa] = useState(false)
  const [showMaterials, setShowMaterials] = useState(false)
  const [referenceVersion, setReferenceVersion] = useState<{ root: string; path: string; revision: string } | null>(null)

  /* Project notes are repository files, not private personal storage. */
  const noteOwner = projectRootKey(snapshot?.meta.root) ?? ''
  const [noteState, setNoteState] = useState<{ owner: string; draft: NoteDraft } | null>(() => {
    const draft = noteDrafts.get(noteOwner)
    return draft ? { owner: noteOwner, draft } : null
  })
  const noteDraft = noteState?.owner === noteOwner ? noteState.draft : null
  const [noteVisible, setNoteVisible] = useState(Boolean(noteDraft))
  const updateNoteDraft = (draft: NoteDraft | null): void => {
    if (!noteOwner) return
    if (draft) noteDrafts.set(noteOwner, draft)
    else noteDrafts.delete(noteOwner)
    setNoteState(draft ? { owner: noteOwner, draft } : null)
  }
  const [noteSaving, setNoteSaving] = useState(false)
  useEffect(() => { setShowMaterials(false); setShowLegacyQa(false); setAiAnswer(null); setAiSources([]); setAiRemoteSources([]); setAiBusy(false) }, [knowledge.current])
  const discussWithAgent = (): void => {
    const root = snapshot?.meta.root
    if (root && knowledge.current()) useKnowledgeDiscussion.getState().show(root)
  }

  useEffect(() => () => {
    searchSeq.current += 1
    companySeq.current += 1
    docSeq.current += 1
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => { setLocalPage(1); setLocalSnapshotNotice(null) }, [debounced])

  /** 公司库检索/浏览：本地结果先上屏，这里异步补充（失败只记错误不打扰本地） */
  const runCompanySearch = useCallback(
    async (mode: 'search' | 'browse') => {
      const seq = ++companySeq.current
      if (!weknoraEnabled) {
        setCompanyHits([])
        setCompanyReadOwner(null)
        setCompanyDocs([])
        setCompanyError(null)
        setCompanyLoading(false)
        return
      }
      setCompanyLoading(true)
      setCompanyError(null)
      if (mode === 'browse') { setCompanyDocs([]); setCompanyHasMore(false); setCompanyPageOwner(null) }
      else { setCompanyHits([]); setCompanySearchOwner(null); setCompanyReadOwner({ query: debounced, scopeRevision: knowledge.context?.scope.revision, current: knowledge.current }) }
      try {
        if (mode === 'search') {
          const bridge = knowledgeBridge(['search'])
          if (!bridge) throw new Error('项目知识服务未加载；不会回退到全局连接')
          const res = requireKnowledge(await bridge.search({ ...knowledge.input, requestId: crypto.randomUUID(), query: debounced, limit: 10 }))
          if (seq !== companySeq.current || !knowledge.current()) return
          setCompanyHits(res.sources.filter((source) => source.kind === 'weknora'))
          setCompanySearchOwner({ query: debounced, scopeRevision: knowledge.context?.scope.revision, current: knowledge.current })
          setCompanyError(res.status === 'ok' || res.status === 'empty' ? (res.persistence === 'degraded' ? '证据保存降级，不保证重开可读' : null) : `${knowledgeStatusLabel[res.status]}：${res.detail}`)
        } else {
          if (!collectionId) { setCompanyDocs([]); setCompanyHasMore(false); return }
          const bridge = knowledgeBridge(['documents'])
          if (!bridge) throw new Error('项目知识服务未加载；不会回退到全局连接')
          const res = requireKnowledge(await bridge.documents({ ...knowledge.input, collectionId, page: companyPage, ...(remoteFolder !== null ? { folderPath: remoteFolder } : {}) }))
          if (seq !== companySeq.current || !knowledge.current()) return
          setCompanyDocs(res.items.map((doc) => ({ ...doc, kbName: collectionId })))
          setCompanyHasMore(res.hasMore)
          setCompanyPageOwner({ collectionId, folder: remoteFolder, page: companyPage, scopeRevision: knowledge.context?.scope.revision, current: knowledge.current })
        }
      } catch (error) {
        if (seq === companySeq.current) setCompanyError(error instanceof Error ? error.message : '知识库读取失败')
      } finally {
        if (seq === companySeq.current) setCompanyLoading(false)
      }
    },
    [debounced, weknoraEnabled, collectionId, companyPage, remoteFolder, knowledge.input, knowledge.current, knowledge.context?.scope.revision]
  )

  const runSearch = useCallback(async (forceRefresh = false) => {
    const seq = ++searchSeq.current
    if (!hasIpc || !snapshot?.meta.root) return
    if (scope === 'company') {
      setLoading(false)
      setResult(null)
      void runCompanySearch(debounced ? 'search' : 'browse')
      return
    }
    if (typeof api?.kbSearch !== 'function') return
    const refreshToken = forceRefresh ? ++refreshSeq.current : null
    let refreshCompleted = false
    if (forceRefresh) setLocalRefreshing(true)
    setLoading(true)
    setResult(null)
    setLocalError(null)
    try {
      if (forceRefresh && debounced && localBrowseMode !== 'legacy' && typeof api.kbBrowse === 'function') {
        try {
          const refreshed = await api.kbBrowse({ expectedRoot: snapshot.meta.root, page: 1, pageSize: 30, forceRefresh: true })
          if (refreshed.ok && knowledge.current()) refreshCompleted = true
          if (seq !== searchSeq.current || !knowledge.current()) return
          if (!refreshed.ok) throw new Error(refreshed.code === 'E_INVALID_ARG' ? '当前桌面服务不支持强制刷新，请完整退出并重新打开应用。' : refreshed.error)
          setLocalFolders(refreshed.folders); setLocalCoverage(localCoverageMessage(refreshed))
        } catch (error) {
          if (!(error instanceof Error) || !/No handler registered|not a function/i.test(error.message)) throw error
          setLocalBrowseMode('legacy')
        }
      }
      if (!debounced && localBrowseMode !== 'legacy' && typeof api.kbBrowse === 'function') {
        try {
          const res = await api.kbBrowse({ expectedRoot: snapshot.meta.root, page: localPage, pageSize: 30, ...(forceRefresh ? { forceRefresh: true } : {}), ...(localFolder ? { folderPath: localFolder, folderRecursive: true } : {}) })
          if (forceRefresh && res.ok && knowledge.current()) refreshCompleted = true
          if (seq !== searchSeq.current || !knowledge.current()) return
          if (!res.ok) throw new Error(forceRefresh && res.code === 'E_INVALID_ARG' ? '当前桌面服务不支持强制刷新，请完整退出并重新打开应用。' : res.error)
          if (res.page !== localPage) throw new Error('本地服务返回的页码不匹配，请刷新重试')
          const previous = localSnapshot.current
          const timestampValid = typeof res.snapshotAt === 'number' && Number.isFinite(res.snapshotAt)
          const sameOwner = previous?.current === knowledge.current && previous.folder === localFolder
          if (localPage > 1 && (!sameOwner || !timestampValid || previous?.snapshotAt !== res.snapshotAt)) {
            setLocalSnapshotNotice({ folder: localFolder, current: knowledge.current, message: !sameOwner || !timestampValid ? '无法验证分页快照，已返回第一页。' : '资料已更新，已返回第一页。' })
            setLocalHasMore(false); setLocalPage(1)
            return
          }
          localSnapshot.current = timestampValid ? { folder: localFolder, current: knowledge.current, snapshotAt: res.snapshotAt } : null
          setLocalBrowseMode('available'); setLocalFolders(res.folders); setLocalHasMore(res.hasMore)
          setLocalCoverage(localCoverageMessage(res))
          setResult({ ok: true, docs: res.docs, hits: [], totalDocs: res.totalDocs, elapsedMs: 0 }); setLocalResultOwner({ query: debounced, folder: localFolder, page: localPage, current: knowledge.current })
        } catch (error) {
          if (seq !== searchSeq.current || !knowledge.current()) return
          if (!(error instanceof Error) || !/No handler registered|not a function/i.test(error.message)) throw error
          setLocalBrowseMode('legacy')
          const res = await api.kbSearch('all', '')
          if (forceRefresh && res.ok && knowledge.current()) refreshCompleted = true
          if (seq !== searchSeq.current || !knowledge.current()) return
          if (res.ok) { setResult(res); setLocalResultOwner({ query: debounced, folder: localFolder, page: localPage, current: knowledge.current }); setBrowseDocs(res.docs) } else { setLocalError(res.error ?? '本地检索失败'); return }
        }
      } else {
        if (!debounced && typeof api.kbBrowse !== 'function') setLocalBrowseMode('legacy')
        const res = await api.kbSearch('all', debounced, debounced && localFolder ? { expectedRoot: snapshot.meta.root, folderPath: localFolder, folderRecursive: true } : undefined)
        if (forceRefresh && (localBrowseMode === 'legacy' || typeof api.kbBrowse !== 'function') && res.ok && knowledge.current()) refreshCompleted = true
        if (seq !== searchSeq.current || !knowledge.current()) return
        if (res.ok) { setResult(res); setLocalResultOwner({ query: debounced, folder: localFolder, page: localPage, current: knowledge.current }); if (!debounced) setBrowseDocs(res.docs) }
        else { setLocalError(res.error ?? '本地检索失败'); return }
      }
    } catch (error) {
      if (seq !== searchSeq.current || !knowledge.current()) return
      setLocalError(error instanceof Error ? error.message : '本地检索失败')
      return
    } finally {
      if (seq === searchSeq.current) setLoading(false)
      if (refreshToken !== null && refreshToken === refreshSeq.current) {
        if (refreshCompleted && knowledge.current()) setLocalRefresh((value) => value + 1)
        setLocalRefreshing(false)
      }
    }
    if (seq !== searchSeq.current || !knowledge.current() || forceRefresh) return
    // 联邦检索：检索态下公司库命中异步追加
    if (debounced) void runCompanySearch('search')
    else {
      companySeq.current += 1
      setCompanyHits([])
      setCompanyError(null)
      setCompanyLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, debounced, runCompanySearch, snapshot?.meta.root, localBrowseMode, localFolder, localPage, localRefresh])

  useEffect(() => {
    searchSeq.current += 1; companySeq.current += 1; docSeq.current += 1
    setActive(null); setRemoteDoc(null); setResult(null); setLocalResultOwner(null); setBrowseDocs([]); setLocalFolders([]); setLocalBrowseMode('checking'); setLocalFolder(''); setLocalPage(1); setLocalHasMore(false); setLocalCoverage(null); localSnapshot.current = null; setLocalSnapshotNotice(null); refreshSeq.current += 1; setLocalRefreshing(false)
    const owner = projectRootKey(snapshot?.meta.root) ?? ''
    const draft = noteDrafts.get(owner)
    setNoteState(draft ? { owner, draft } : null); setNoteVisible(Boolean(draft))
    setCompanyDocs([]); setCompanyPageOwner(null); setCompanyHits([]); setCompanySearchOwner(null); setCompanyReadOwner(null); setCollections([]); setCollectionId(''); setCompanyPage(1); setRemoteFolder(null); setRemoteTree(null); setRemoteTreeError(null)
  }, [snapshot?.meta.root])

  useEffect(() => {
    if (!hasIpc) return
    void runSearch()
    // 切库时关闭远程阅读器
  }, [runSearch, snapshot?.meta.root])

  useEffect(() => {
    if (!hasIpc || typeof api?.kbSearch !== 'function' || scope === 'company' || !snapshot?.meta.root || !query.trim()) return
    let live = true
    if (localBrowseMode !== 'legacy' && typeof api.kbBrowse === 'function') {
      void api.kbBrowse({ expectedRoot: snapshot.meta.root, page: 1, pageSize: 30 }).then((res) => {
        if (!live || !knowledge.current()) return
        if (res.ok) { setLocalBrowseMode('available'); setLocalFolders(res.folders); setLocalCoverage(localCoverageMessage(res)) }
        else setLocalError(res.error)
      }).catch((error: unknown) => {
        if (!live || !knowledge.current()) return
        if (error instanceof Error && /No handler registered|not a function/i.test(error.message)) setLocalBrowseMode('legacy')
        else setLocalError(error instanceof Error ? error.message : '本地目录读取失败')
      })
    } else {
      void api.kbSearch('all', '').then((res) => {
        if (live && knowledge.current() && res.ok) setBrowseDocs(res.docs)
      }).catch(() => { /* Search has its own visible error state. */ })
    }
    return () => { live = false }
  }, [snapshot?.meta.root, scope, Boolean(query.trim()), knowledge.current, localBrowseMode, localRefresh])

  useEffect(() => {
    const ids = knowledge.context?.scope.collectionIds ?? NO_KB_IDS
    setCollectionId((old) => ids.includes(old) ? old : ids[0] ?? '')
    setCompanyPage(1)
    if (!knowledge.context?.scope.connectionId || !ids.length) { setCollections([]); return }
    let live = true
    const bridge = knowledgeBridge(['collections'])
    if (!bridge) { setCollections(ids.map((id) => ({ id, name: id, knowledgeCount: 0 }))); return }
    void bridge.collections(knowledge.input).then((res) => {
      if (!live || !knowledge.current()) return
      const items = res.ok ? res.data.items : []
      setCollections(ids.map((id) => items.find((item) => item.id === id) ?? { id, name: id, knowledgeCount: 0 }))
    }).catch(() => { if (live && knowledge.current()) setCollections(ids.map((id) => ({ id, name: id, knowledgeCount: 0 })) ) })
    return () => { live = false }
  }, [knowledge.context, knowledge.input, knowledge.current])

  useEffect(() => {
    let live = true
    setRemoteFolder(null); setRemoteTree(null); setRemoteTreeError(null); setCompanyPage(1)
    if (!collectionId || !weknoraEnabled) return () => { live = false }
    const bridge = knowledgeBridge(['folders'])
    if (!bridge) {
      setRemoteTreeError('当前桌面服务不支持远端目录；可继续浏览知识库分页。请完整退出并重新打开应用。')
      return () => { live = false }
    }
    void bridge.folders({ ...knowledge.input, collectionId }).then((result) => {
      if (!live || !knowledge.current()) return
      if (result.ok) setRemoteTree(result.data)
      else setRemoteTreeError(`远端目录不可用：${result.error}；可继续浏览知识库分页。`)
    }).catch((error: unknown) => {
      if (live && knowledge.current()) setRemoteTreeError(`远端目录不可用：${knowledgeError(error)}；可继续浏览知识库分页。`)
    })
    return () => { live = false }
  }, [collectionId, weknoraEnabled, knowledge.input, knowledge.current, knowledge.context?.scope.revision, treeRefresh])

  useEffect(() => {
    docSeq.current += 1
    setRemoteDoc(null)
  }, [knowledge.context?.scope.revision])

  useEffect(() => { docSeq.current += 1; setActive(null); setRemoteDoc(null) }, [knowledgeView])

  const browseLocalDirectory = useCallback(async (folderPath: string, page: number): Promise<KbBrowseSuccess> => {
    if (!hasIpc || !knowledge.input.expectedRoot || typeof api?.kbBrowse !== 'function' || !knowledge.current()) throw new Error('本地目录服务不可用')
    const res = await api.kbBrowse({ ...knowledge.input, folderPath, page, pageSize: 20 })
    if (!knowledge.current()) throw new Error('项目已切换')
    if (!res.ok) throw new Error(res.error)
    return res
  }, [knowledge.input, knowledge.current])

  const focusReader = (): void => {
    if ((pageRef.current?.clientWidth ?? 0) < 1000) {
      requestAnimationFrame(() => readerRef.current?.focus({ preventScroll: true }))
    }
  }

  const openDoc = useCallback(async (doc: KbDoc): Promise<void> => {
    if (!doc.synthetic && relativePathUnderRoot(snapshot?.meta.root ?? '', doc.path) !== null) rememberVisit({ kind: 'document', target: doc.path, title: doc.title })
    const seq = ++docSeq.current
    setRemoteDoc(null)
    setNoteVisible(false)
    setReaderOwner({ root: projectRootKey(snapshot?.meta.root), view: knowledgeView, current: knowledge.current })
    setActive(doc)
    focusReader()
    setDocContent(null)
    setDocError(null)
    // Project files use the shared version-aware reader below; remote content does not.
    if (doc.synthetic || relativePathUnderRoot(snapshot?.meta.root ?? '', doc.path) !== null) return
    try {
      const res = await api.readTextFile(doc.path)
      if (seq !== docSeq.current || !knowledge.current()) return
      if (res.ok && res.content !== undefined) setDocContent(res.content)
      else setDocError(res.error ?? '读取失败')
    } catch (error) {
      if (seq === docSeq.current && knowledge.current()) setDocError(error instanceof Error ? error.message : '读取失败')
    }
  }, [snapshot?.meta.root, knowledge.current, knowledgeView])

  /** 打开公司库（WeKnora）文档：拉取 preview 正文 */
  const openRemoteDoc = useCallback(async (hit: { knowledgeId: string; title: string }): Promise<void> => {
    const seq = ++docSeq.current
    setActive(null)
    setNoteVisible(false)
    focusReader()
    setReaderOwner({ root: projectRootKey(knowledge.input.expectedRoot), view: knowledgeView, current: knowledge.current })
    setRemoteDoc({ knowledgeId: hit.knowledgeId, title: hit.title, fileName: '', content: null, loading: true })
    try {
      const bridge = knowledgeBridge(['read'])
      if (!bridge) throw new Error('项目知识读取服务不可用')
      const res = requireKnowledge(await bridge.read({ ...knowledge.input, requestId: crypto.randomUUID(), sourceHandle: hit.knowledgeId }))
      if (seq !== docSeq.current || !knowledge.current()) return
      const source = res.source
      setRemoteDoc({ knowledgeId: hit.knowledgeId, title: source?.title || hit.title, fileName: '', content: source?.text ?? null, loading: false, snapshot: source ?? undefined, error: res.status === 'ok' ? undefined : `${knowledgeStatusLabel[res.status]}：${res.detail}` })
    } catch (error) {
      if (seq === docSeq.current && knowledge.current()) setRemoteDoc({ knowledgeId: hit.knowledgeId, title: hit.title, fileName: '', content: null, loading: false, error: error instanceof Error ? error.message : '知识库文档读取失败' })
    }
  }, [knowledge.input, knowledge.current, knowledgeView])

  /* AI 问答（本地 + 公司库上下文） */
  const aiAsk = async (): Promise<void> => {
    const q = aiQuestion.trim()
    if (!q || aiBusy) return
    setAiBusy(true)
    setAiAnswer(null)
    setAiSources([])
    setAiRemoteSources([])
    try {
      let context = ''
      if (scope === 'company' && !weknoraEnabled) throw new Error(knowledge.error || knowledge.context?.scope.detail || '当前项目未配置可用远端范围，未检查公司知识')
      const sources: KbDoc[] = []
      if (scope !== 'company') {
        const search = await api.kbSearch('all', q)
        if (!knowledge.current()) return
        const top = search.ok ? search.hits.slice(0, 6) : []
        for (const h of top) {
          const res = await api.readTextFile(h.doc.path)
          if (!knowledge.current()) return
          const content = res.ok && res.content ? res.content.slice(0, 4000) : h.snippet.replace(/[\u0000\u0001]/g, '')
          context += `\n\n--- 来源：${h.doc.title}（${h.doc.path}）---\n${content}`
          sources.push(h.doc)
        }
        setAiSources(sources)
      }
      // 公司库补充上下文（启用且配置了检索范围时）
      const remoteSources: KnowledgeSource[] = []
      if (weknoraEnabled && weknoraKbIds.length > 0 && (scope === 'all' || scope === 'company')) {
        const bridge = knowledgeBridge(['search'])
        if (!bridge) throw new Error('项目知识服务未加载，未检查远端来源')
        const remote = requireKnowledge(await bridge.search({ ...knowledge.input, requestId: crypto.randomUUID(), query: q, limit: 3 }))
        if (!knowledge.current()) return
        if (!['ok', 'empty'].includes(remote.status)) throw new Error(`${knowledgeStatusLabel[remote.status]}：${remote.detail}；未生成“已核对来源”的回答`)
        for (const source of remote.sources.filter((item) => item.kind === 'weknora')) {
          context += `\n\n--- 来源 [知识库]：${source.title}（摘录 ${source.contentHash}）---\n${source.text}`
          remoteSources.push(source)
        }
        setAiRemoteSources(remoteSources)
      }
      const res = await api.aiChat([
        {
          role: 'system',
          content:
            '你是项目知识助手。仅依据提供的知识库上下文回答问题；上下文不足时明确说明并给出建议去哪里补充。用中文回答，引用来源时标注标题（WeKnora 来源注明 [知识库]）。'
        },
        { role: 'user', content: `知识库上下文：\n${context || '（未检索到相关内容）'}\n\n问题：${q}` }
      ])
      if (!knowledge.current()) return
      if (res.ok && res.content) {
        setAiAnswer(res.content)
        // 问答历史落盘（userData，个人维度）
        const sourcesForHistory = [
          ...sources.map((s) => ({ title: s.title, path: s.path, library: s.library })),
          ...remoteSources.map((source) => ({ title: source.title, path: source.id, library: '知识库快照' }))
        ]
        void api.kbQaSave({ question: q, answer: res.content, sources: sourcesForHistory }).then((r) => {
          if (knowledge.current() && r.ok && r.entries) setQaHistory(r.entries)
        })
      } else {
        pushToast({ kind: 'error', title: 'AI 回答失败', body: res.error })
      }
    } catch (failure) { if (knowledge.current()) pushToast({ kind: 'error', title: '兼容问答未完成', body: knowledgeError(failure) }) } finally {
      if (knowledge.current()) setAiBusy(false)
    }
  }

  /* Project-note editing uses the existing repository note service. */
  const startNewNote = (): void => {
    if (!snapshot?.meta.root || !hasIpc || typeof api?.kbSearch !== 'function' || typeof api?.kbSaveNote !== 'function' || !result?.ok || !localResultOwner || localResultOwner.current !== knowledge.current || localResultOwner.query !== query.trim() || localResultOwner.folder !== localFolder || localResultOwner.page !== localPage || localError || !knowledge.current()) return
    docSeq.current += 1
    setActive(null)
    setRemoteDoc(null)
    if (!noteDraft) updateNoteDraft({ name: '', content: '# 新笔记\n\n', isNew: true })
    setNoteVisible(true)
    focusReader()
  }

  const startEditNote = (doc: KbDoc): void => {
    if (doc.synthetic) return
    if (noteDraft) { setNoteVisible(true); pushToast({ kind: 'info', title: '已有未保存的笔记', body: '请先保存或放弃当前草稿' }); return }
    const seq = ++docSeq.current
    void api.readTextFile(doc.path).then((r) => {
      if (seq !== docSeq.current || !knowledge.current()) return
      if (!r.ok || r.content === undefined) {
        pushToast({ kind: 'error', title: '无法编辑笔记', body: r.error ?? '读取失败' })
        return
      }
      updateNoteDraft({ name: doc.name, content: r.content, isNew: false }); setNoteVisible(true)
    }).catch((error: unknown) => {
      if (seq === docSeq.current && knowledge.current()) pushToast({ kind: 'error', title: '无法编辑笔记', body: error instanceof Error ? error.message : '读取失败' })
    })
  }

  const refreshDetachedNoteChange = async (): Promise<void> => {
    const root = snapshot?.meta.root
    if (!root || !knowledge.current()) return
    if (typeof api?.kbBrowse !== 'function') return // Legacy browsing performs a fresh search when revisited.
    const token = ++refreshSeq.current
    setLocalRefreshing(true)
    try {
      const refreshed = await api.kbBrowse({ expectedRoot: root, page: 1, pageSize: 30, forceRefresh: true })
      if (!knowledge.current() || token !== refreshSeq.current) return
      if (!refreshed.ok) throw new Error(refreshed.code === 'E_INVALID_ARG' ? '当前桌面服务不支持强制刷新，请完整退出并重新打开应用。' : refreshed.error)
      setLocalFolders(refreshed.folders); setLocalCoverage(localCoverageMessage(refreshed)); setLocalRefresh((value) => value + 1)
    } catch (error) {
      if (knowledge.current() && token === refreshSeq.current) pushToast({ kind: 'error', title: '笔记已更新，目录刷新失败', body: error instanceof Error ? error.message : '请重新打开桌面应用' })
    } finally {
      if (token === refreshSeq.current) setLocalRefreshing(false)
    }
  }

  const saveNote = async (): Promise<void> => {
    if (!noteDraft || noteSaving || !snapshot?.meta.root || !hasIpc || typeof api?.kbSaveNote !== 'function' || !knowledge.current()) return
    const name = noteDraft.name.trim()
    if (!name) {
      pushToast({ kind: 'error', title: '请填写笔记名' })
      return
    }
    const seq = docSeq.current
    setNoteSaving(true)
    try {
      const res = await api.kbSaveNote(name, noteDraft.content)
      if (!knowledge.current()) return
      if (seq !== docSeq.current) { if (res.ok) void refreshDetachedNoteChange(); return }
      if (res.ok) {
        pushToast({ kind: 'success', title: '笔记已保存', body: '已写入 .trellis/notes/，检索立即可用' })
        updateNoteDraft(null); setNoteVisible(false)
        void runSearch(true)
      } else {
        pushToast({ kind: 'error', title: '保存失败', body: res.error })
      }
    } catch (error) {
      if (seq === docSeq.current && knowledge.current()) pushToast({ kind: 'error', title: '保存失败', body: error instanceof Error ? error.message : '写入失败' })
    } finally {
      setNoteSaving(false)
    }
  }

  const discardNote = async (): Promise<void> => {
    const draft = noteDraft
    const owner = noteOwner
    if (!draft || noteSaving) return
    const confirmed = await confirmDialog({ title: '放弃笔记草稿？', message: '尚未保存的修改将被丢弃。', confirmText: '放弃草稿' })
    if (!confirmed || projectRootKey(useApp.getState().snapshot?.meta.root) !== owner || noteDrafts.get(owner) !== draft) return
    updateNoteDraft(null); setNoteVisible(false)
  }

  const deleteNote = async (doc: KbDoc): Promise<void> => {
    const seq = docSeq.current
    const res = await api.kbDeleteNote(doc.name)
    if (!knowledge.current()) return
    if (seq !== docSeq.current) { if (res.ok) void refreshDetachedNoteChange(); return }
    if (res.ok) {
      pushToast({ kind: 'success', title: '笔记已删除' })
      setActive(null)
      void runSearch(true)
    } else {
      pushToast({ kind: 'error', title: '删除失败', body: res.error })
    }
  }

  useEffect(() => {
    if (!hasIpc) return
    void api.kbQaHistory().then((r) => {
      if (r.ok && r.entries) setQaHistory(r.entries)
    })
  }, [])

  const companyOwnerMatches = (owner: typeof companySearchOwner): boolean => Boolean(
    owner && owner.query === query.trim() && owner.current === knowledge.current && knowledge.current() && owner.scopeRevision === knowledge.context?.scope.revision
  )
  const currentCompanySearch = companyOwnerMatches(companySearchOwner)
  const currentCompanyRead = companyOwnerMatches(companyReadOwner)
  const currentCompanyHits = currentCompanySearch ? companyHits : []
  const currentCompanyError = currentCompanyRead ? companyError : null
  const currentScope = knowledge.context?.scope
  const scopeFailure = currentScope && ['denied', 'unavailable', 'partial', 'cancelled'].includes(currentScope.status)
    ? `${knowledgeStatusLabel[currentScope.status]}${currentScope.detail ? `：${currentScope.detail}` : ''}` : null
  const remoteSearchPending = Boolean(query.trim() && hasIpc && snapshot?.meta.root && !knowledge.error && !scopeFailure &&
    ((!knowledge.context) || (weknoraEnabled && (!currentCompanyRead || companyLoading))))
  const localResultCurrent = Boolean(result && localResultOwner && localResultOwner.current === knowledge.current && knowledge.current() && localResultOwner.query === query.trim() && localResultOwner.folder === localFolder && localResultOwner.page === localPage)
  const isSearch = debounced.length > 0
  const list: Array<{ doc: KbDoc; hit?: KbHit }> = useMemo(() => {
    if (!result) return []
    return isSearch ? result.hits.map((hit) => ({ doc: hit.doc, hit })) : result.docs.map((doc) => ({ doc }))
  }, [result, isSearch])

  const LIB_ICON: Record<KbLibrary, JSX.Element> = {
    notes: <StickyNote size={12} />,
    requirements: <ScrollText size={12} />,
    spec: <BookOpenText size={12} />,
    wiki: <FileText size={12} />,
    archive: <Archive size={12} />
  }

  const relativePath = active && !active.synthetic ? relativePathUnderRoot(snapshot?.meta.root ?? '', active.path) : null
  const displayedRevision = readerCurrent && active && snapshot && referenceVersion?.root === snapshot.meta.root && referenceVersion.path === active.path ? referenceVersion.revision : undefined
  const stageReference = (source: KnowledgeSource | { title: string; relativePath: string; displayedRevision: string }): void => {
    const root = snapshot?.meta.root
    if (!root || !readerCurrent) return
    const context = knowledge.context
    if (!context?.selectionToken || projectRootKey(context.scope.root) !== projectRootKey(root) || !knowledge.current()) {
      pushToast({ kind: 'warn', title: '无法加入知识引用', body: '项目知识范围尚未就绪，请刷新后重试。' }); return
    }
    const owner = { root, selectionToken: context.selectionToken, projectGeneration: context.scope.projectGeneration }
    const staged = 'sourceHandle' in source ? stageKnowledgeReferenceHandoff({ ...owner, source }) : stageKnowledgeReferenceHandoff({ ...owner, document: source })
    if (!staged) { pushToast({ kind: 'warn', title: '无法加入知识引用', body: '请先处理当前待加入的资料，或重新打开文档。' }); return }
    useKnowledgeDiscussion.getState().show(root)
  }
  const scopeInfo = knowledge.context?.scope
  const scopeSummary = knowledge.error
    ? knowledge.error
    : !scopeInfo
      ? (knowledge.loading ? '读取范围…' : '不可用')
      : scopeInfo.status === 'not_configured'
        ? '未配置检索范围'
        : `${knowledgeStatusLabel[scopeInfo.status]} · ${scopeInfo.collectionIds.length} 个库`
  useEffect(() => { setScopeOpen(false) }, [snapshot?.meta.root])

  return (
    <div ref={pageRef} className="flex h-full min-h-0 min-w-0 flex-row bg-my-surface-1">
      {/* 左列：知识导航、来源与检索 */}
      <ContextRegion collapsed={sidebarCollapsed}><div id="knowledge-browser" style={sidebarStyle} className="my-context-sidebar flex shrink-0 flex-col border-r border-my-line">
        <SidebarResizeHandle />
        <header className="flex h-my-header shrink-0 items-center px-4">
          <h1 className="my-sidebar-heading flex-1 truncate font-medium text-my-primary">知识</h1>
        </header>
        <ModuleLinks domain="knowledge" />

      </div></ContextRegion>

      {/* 右列：当前知识视图与阅读器 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-my-surface-1">
        <div className="my-page-toolbar-row flex-wrap">
          <h1 className="text-my-md font-semibold text-my-primary">{knowledgeView === 'company' ? '知识库' : '资料'}</h1>
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" disabled={!snapshot?.meta.root} onClick={() => setScopeOpen(true)} title={`${scopeInfo?.connectionName ?? '项目知识'} · ${scopeSummary}`}><Cloud size={13} />知识范围</Button>
            <Button size="sm" variant="ghost" onClick={() => void runSearch(true)} disabled={!hasIpc || !snapshot?.meta.root || (scope !== 'company' && typeof api?.kbSearch !== 'function') || localRefreshing || loading || companyLoading} title="刷新当前视图"><RefreshCw size={13} />刷新</Button>
            <Button data-knowledge-discussion-trigger="" size="sm" variant="outline" disabled={!snapshot?.meta.root} onClick={discussWithAgent}><Sparkles size={13} />在 Agent 中讨论</Button>
            {scope !== 'company' && noteDraft && !noteVisible && <Button size="sm" variant="ghost" onClick={() => { docSeq.current += 1; setActive(null); setRemoteDoc(null); setNoteVisible(true) }}>恢复未保存笔记</Button>}
            <Dropdown align="right" width={180} trigger={({ open, toggle }) => <Button size="sm" variant="ghost" aria-label="更多知识操作" aria-expanded={open} onClick={toggle}>更多</Button>}>
              {(close) => <><DropdownItem disabled={!snapshot?.meta.root} onClick={() => { close(); setShowMaterials(true) }}>需求材料</DropdownItem><DropdownItem onClick={() => { close(); setShowLegacyQa((value) => !value) }}>{showLegacyQa ? '关闭旧版问答' : '旧版问答与历史'}</DropdownItem></>}
            </Dropdown>
          </div>
        </div>
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <KnowledgeBrowser root={snapshot?.meta.root ?? ''} remote={scope === 'company'} query={query} onQuery={setQuery}
            serviceAvailable={hasIpc && (scope === 'company' ? Boolean(knowledgeBridge(['context'])) : typeof api?.kbSearch === 'function')}
            noteAvailable={Boolean(snapshot?.meta.root && hasIpc && typeof api?.kbSearch === 'function' && typeof api?.kbSaveNote === 'function' && result?.ok && localResultCurrent && !localError && knowledge.current())}
            resultsReady={scope === 'company' ? currentCompanySearch : localResultCurrent}
            remoteScopePending={!knowledge.context && !knowledge.error}

            browseDocs={browseDocs} localRows={list} localTotal={result?.totalDocs ?? 0}
            localSnapshotNotice={!query.trim() && localSnapshotNotice?.folder === localFolder && localSnapshotNotice.current === knowledge.current && knowledge.current() ? localSnapshotNotice.message : null} localSearchScoped={Boolean(localResultCurrent && result?.scopeApplied)} localSearchIncomplete={Boolean(localResultCurrent && result?.scopeApplied && result.complete !== true)} localSearchHasMore={Boolean(localResultCurrent && result?.scopeApplied && result.hasMore)} localCoverage={localCoverage} localFolders={localFolders} localPaged={localBrowseMode === 'available'} localLegacy={localBrowseMode === 'legacy'} localPage={localPage} localHasMore={localHasMore} localRefresh={localRefresh} localRefreshing={localRefreshing}
            onLocalFolder={(path) => { if (path !== localFolder) { setLocalSnapshotNotice(null); setLocalFolder(path); setLocalPage(1) } }} onLocalPage={setLocalPage} browseLocalDirectory={browseLocalDirectory}
            collections={collections} collectionId={collectionId} onCollection={(id) => { setRemoteFolder(null); setCollectionId(id); setCompanyPage(1) }}
            remoteTree={remoteTree} remoteTreeError={remoteTreeError} onRetryTree={() => setTreeRefresh((value) => value + 1)} remoteFolder={remoteFolder} onRemoteFolder={(path) => { setRemoteFolder(path); setCompanyPage(1) }}
            remoteDocs={companyDocs} remotePageReady={Boolean(companyPageOwner && companyPageOwner.collectionId === collectionId && companyPageOwner.folder === remoteFolder && companyPageOwner.page === companyPage && companyPageOwner.current === knowledge.current && knowledge.current() && companyPageOwner.scopeRevision === knowledge.context?.scope.revision && !debounced && !query.trim())} remoteHits={currentCompanyHits} remotePage={companyPage} remoteHasMore={companyHasMore}
            onRemotePage={setCompanyPage} onIntegrations={() => setPage('integrations')} remoteEnabled={weknoraEnabled} loading={scope === 'company' ? companyLoading : loading} error={scope === 'company' ? ((query.trim() ? currentCompanyError : companyError) || knowledge.error || scopeFailure || null) : localError} remoteSearchError={scope !== 'company' && query.trim() ? (knowledge.error || scopeFailure || currentCompanyError || null) : null} remoteSearchPending={scope !== 'company' && remoteSearchPending}
            onOpenLocal={(doc) => void openDoc(doc)} onOpenRemote={(handle, title) => void openRemoteDoc({ knowledgeId: handle, title })}
            onBrowse={() => { docSeq.current += 1; setActive(null); setRemoteDoc(null); setNoteVisible(false) }} onNewNote={startNewNote}
            selectedLocal={readerCurrent ? active?.id : undefined} selectedRemote={readerCurrent ? remoteDoc?.knowledgeId : undefined} treeVisible={directoryVisible} treeOverlay={discussionOpen}
            showList={!(scope !== 'company' && noteDraft && noteVisible) && !(readerCurrent && (remoteDoc || active)) && !showLegacyQa}>
        <div ref={readerRef} tabIndex={-1} aria-label="知识阅读区" className="flex min-h-0 min-w-0 flex-1 flex-col bg-my-surface-1 outline-none">
        {scope !== 'company' && noteDraft && noteVisible ? (
          <>
            <div className="my-page-toolbar-row">
              <span className="my-chip bg-my-label-emerald text-my-label-emerald-text">
                <StickyNote size={12} /> {noteDraft.isNew ? '新建笔记' : '编辑笔记'}
              </span>
              <input
                value={noteDraft.name}
                onChange={(e) => updateNoteDraft({ ...noteDraft, name: e.target.value })}
                placeholder="笔记名（支持中英文/数字/空格）"
                className="min-w-0 max-w-[260px] flex-1 rounded-my-md border border-my-line bg-my-layer-2 px-2 py-1 font-mono text-my-xs text-my-primary outline-none focus:border-my-line-accent"
                disabled={!noteDraft.isNew}
              />
              <div className="ml-auto flex items-center gap-1.5">
                <Button variant="primary" size="sm" onClick={() => void saveNote()} disabled={noteSaving}>
                  {noteSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} 保存
                </Button>
                <Button variant="ghost" size="sm" disabled={noteSaving} onClick={() => void discardNote()}>放弃草稿</Button>
                <Button variant="ghost" size="sm" disabled={noteSaving} className="px-1.5" onClick={() => { docSeq.current += 1; setNoteVisible(false) }} title="关闭编辑器，保留草稿" aria-label="关闭编辑器，保留草稿">
                  <X size={13} />
                </Button>
              </div>
            </div>
            <div className="my-page-workspace-padding min-h-0 flex-1">
              <textarea
                value={noteDraft.content}
                onChange={(e) => updateNoteDraft({ ...noteDraft, content: e.target.value })}
                spellCheck={false}
                className="h-full w-full resize-none rounded-my-lg border border-my-line bg-my-surface-1 p-4 font-mono text-my-sm leading-6 text-my-primary outline-none focus:border-my-line-accent"
                placeholder="# 标题&#10;&#10;用 Markdown 记录知识，保存后立即进入五库检索与 AI 问答…"
              />
            </div>
          </>
        ) : readerCurrent && remoteDoc ? (
          <>
            <div className="my-page-toolbar-row">
              <span className="my-chip bg-my-accent-subtle text-my-2xs text-my-accent-text">
                <Cloud size={12} /> 知识库
              </span>
              <span className="my-item-title min-w-0 truncate">{remoteDoc.title}</span>
              <div className="ml-auto flex items-center gap-1.5">
                <Button variant="ghost" size="sm" className="px-1.5" onClick={() => { docSeq.current += 1; setRemoteDoc(null) }} title="关闭">
                  <X size={13} />
                </Button>
              </div>
            </div>
            <div className="my-scrollbar min-h-0 flex-1">
              <PageContent variant="centered">
                {remoteDoc.snapshot && snapshot && <KnowledgeSourceView key={remoteDoc.snapshot.id} root={snapshot.meta.root} initial={remoteDoc.snapshot} onUseSource={stageReference} />}
                {remoteDoc.fileName && <div className="mb-3 truncate font-mono text-my-xs text-my-tertiary">{remoteDoc.fileName}</div>}
                {remoteDoc.loading && (
                  <div className="flex items-center gap-2 py-8 text-my-xs text-my-tertiary">
                    <Loader2 size={14} className="animate-spin" /> 正在从知识库读取正文…
                  </div>
                )}
                {remoteDoc.error && (
                  <div className="rounded-my-lg border border-my-line-danger bg-my-danger-subtle p-3 text-my-xs text-my-danger-text">{remoteDoc.error}</div>
                )}
                {!remoteDoc.snapshot && remoteDoc.content !== null && (
                  remoteDoc.fileName.endsWith('.md') || remoteDoc.fileName.endsWith('.markdown') ? (
                    <MarkdownView content={remoteDoc.content} />
                  ) : (
                    <pre className="whitespace-pre-wrap break-words rounded-my-lg border border-my-line bg-my-surface-1 p-3 font-mono text-my-sm leading-5 text-my-primary">{remoteDoc.content}</pre>
                  )
                )}
              </PageContent>
            </div>
          </>
        ) : readerCurrent && active ? (
          <>
            <div className="my-page-toolbar-row">
              <span className={clsx('my-chip', LIB_CHIP[active.library])}>
                {LIB_ICON[active.library]} {LIB_META[active.library].label}
              </span>
              <span className="my-item-title min-w-0 truncate">{active.title}</span>
              <span className="shrink-0 font-mono text-my-2xs text-my-tertiary">{fmtBytes(active.size)} · {relTime(active.mtime)}</span>
              <div className="ml-auto flex items-center gap-1.5">
                {relativePath !== null && <Button variant="ghost" size="sm" disabled={!displayedRevision} onClick={() => { if (displayedRevision) stageReference({ title: active.title, relativePath, displayedRevision }) }}>引用到 Agent</Button>}
                {!active.synthetic && active.library === 'spec' && (
                  <Button variant="ghost" size="sm" onClick={() => openSpecDocument(active.path)}>去规范页编辑</Button>
                )}
                {!active.synthetic && active.library === 'notes' && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => startEditNote(active)} title="编辑这篇笔记">
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="px-1.5 text-my-danger-text"
                      onClick={() => void deleteNote(active)}
                      title="删除笔记"
                    >
                      <Trash2 size={12} />
                    </Button>
                  </>
                )}
                <Button variant="ghost" size="sm" className="px-1.5" onClick={() => void api.revealInExplorer(active.path)} title="在资源管理器显示">
                  <ExternalLink size={12} />
                </Button>
                <Button variant="ghost" size="sm" className="px-1.5" onClick={() => { docSeq.current += 1; setActive(null) }} title="关闭">
                  <X size={13} />
                </Button>
              </div>
            </div>
            <div className="my-scrollbar min-h-0 flex-1">
              <PageContent variant="centered">
                <div className="mb-3 truncate font-mono text-my-xs text-my-tertiary" title={active.path}>{active.path}</div>
                {docError && <div className="rounded-my-lg border border-my-line-danger bg-my-danger-subtle p-3 text-my-xs text-my-danger-text">{docError}</div>}
                {active.synthetic && (
                  <div className="rounded-my-lg border border-my-line bg-my-layer-1 p-4 text-my-xs leading-6 text-my-primary">
                    这是任务提炼的合成文档（task.json 的描述 / 备注 / 子任务）。原始 JSON：
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-2"
                      onClick={() => openArtifact({ name: 'task.json', path: active.path, kind: 'file', size: active.size, mtime: active.mtime, ext: '.json' }, true)}
                    >
                      查看 task.json
                    </Button>
                  </div>
                )}
                {!active.synthetic && relativePath !== null && snapshot && (
                  <DocumentReader key={`${snapshot.meta.root}:${active.path}`} workspaceId={snapshot.meta.root} relativePath={relativePath} onDisplayedRevision={(value) => {
                    const root = snapshot.meta.root
                    const path = active.path
                    setReferenceVersion((current) => value && value.relativePath === relativePath ? { root, path, revision: value.displayedRevision } : current?.root === root && current.path === path ? null : current)
                  }} />
                )}
                {relativePath === null && docContent !== null && (active.path.endsWith('.md') || active.path.endsWith('.markdown') ? (
                  <MarkdownView content={docContent} />
                ) : (
                  <pre className="whitespace-pre-wrap break-words rounded-my-lg border border-my-line bg-my-surface-1 p-3 font-mono text-my-sm leading-5 text-my-primary">{docContent}</pre>
                ))}
              </PageContent>
            </div>
          </>
        ) : null}

        {/* AI 问答条 */}
        {showLegacyQa && (
          <div className="shrink-0 border-t border-my-line bg-my-layer-1 py-2.5">
            <p className="px-4 pb-2 text-my-2xs text-my-tertiary">兼容：一次性知识问答（独立模型，不是可恢复的 Agent 对话）；需要持续追问请前往 Agent。</p>
            {qaHistory.length > 0 && (
              <PageSection variant="centered" className="mb-2">
                <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowHistory((v) => !v)}
                  className="flex w-full items-center gap-1.5 text-my-xs text-my-tertiary hover:text-my-secondary"
                >
                  <History size={11} /> 本机个人问答历史（跨项目，{qaHistory.length}）
                  <span className="flex-1" />
                  <span className="text-my-placeholder">{showHistory ? '收起' : '展开'}</span>
                </button>
                  {!showHistory && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        void (async () => {
                          if (!await confirmDialog({ title: '清空问答历史？', message: '本机跨项目的旧版问答历史将被删除。', confirmText: '清空历史' })) return
                          try {
                            const result = await api.kbQaClear()
                            if (result.ok) setQaHistory([])
                            else pushToast({ kind: 'error', title: '清空历史失败', body: '请重试' })
                          } catch (error) { pushToast({ kind: 'error', title: '清空历史失败', body: error instanceof Error ? error.message : '请重试' }) }
                        })()
                      }}
                      className="ml-2 text-my-placeholder hover:text-my-danger-text"
                      title="清空问答历史"
                    >
                      清空
                    </button>
                  )}
                </div>
                {showHistory && (
                  <div className="my-scrollbar mt-1.5 max-h-40 space-y-1 overflow-y-auto">
                    {qaHistory.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => {
                          setAiQuestion(h.question)
                          setAiAnswer(h.answer)
                          setAiSources([])
                          setAiRemoteSources([])
                        }}
                        className="block w-full truncate rounded-my-md border border-my-line bg-my-layer-2 px-2.5 py-1.5 text-left text-my-xs text-my-secondary hover:border-my-line-strong hover:text-my-primary"
                        title={h.question}
                      >
                        <span className="text-my-placeholder">{relTime(h.createdAt)}</span> · {h.question}
                      </button>
                    ))}
                  </div>
                )}
              </PageSection>
            )}
            {aiAnswer && (
              <PageSection variant="centered" className="mb-2.5">
                <div className="rounded-my-lg border border-my-line-accent-subtle bg-my-accent-subtle p-3">
                  <MarkdownView content={aiAnswer} />
                  {aiSources.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1 border-t border-my-line pt-2">
                      {aiSources.map((s) => (
                        <button key={s.id} type="button" onClick={() => void openDoc(s)} className="my-chip border border-my-line bg-my-layer-2 text-my-2xs text-my-tertiary hover:text-my-primary">
                          {s.title}
                        </button>
                      ))}
                    </div>
                  )}
                  {aiRemoteSources.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {aiRemoteSources.map((h, i) => (
                        <button
                          key={`${h.id}-${i}`}
                          type="button"
                          onClick={() => void openRemoteDoc({ knowledgeId: h.sourceHandle, title: h.title })}
                          className="my-chip border border-my-line-accent-subtle bg-my-surface-1 text-my-2xs text-my-accent-text hover:bg-my-accent-subtle"
                        >
                          <Cloud size={10} /> {h.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </PageSection>
            )}
            <PageSection variant="centered" className="flex items-center gap-2">
              <Sparkles size={13} className="shrink-0 text-my-icon-accent" />
              <input
                disabled={!aiEnabled}
                value={aiQuestion}
                onChange={(e) => setAiQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void aiAsk()
                }}
                placeholder={!aiEnabled ? '启用 AI 后可继续提问，历史仍可查看' : scope === 'company' ? '向知识库提问…' : '向资料库提问…'}
                className="my-input flex-1"
              />
              <Button variant="primary" onClick={() => void aiAsk()} disabled={!aiEnabled || aiBusy || !aiQuestion.trim()}>
                {aiBusy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} 提问
              </Button>
            </PageSection>
          </div>
        )}
        </div>
          </KnowledgeBrowser>
          <button type="button" onClick={() => discussionOpen ? setDiscussionTreeVisible((value) => !value) : setTreeVisible((value) => !value)} aria-expanded={directoryVisible} aria-controls="knowledge-directory" aria-label={directoryVisible ? '收起文件目录' : '展开文件目录'} title={directoryVisible ? '收起文件目录' : discussionOpen ? '展开文件目录（覆盖阅读区）' : '展开文件目录'} className="knowledge-browser-toggle my-icon-control border border-my-line bg-my-surface-1" data-tree-open={directoryVisible} data-tree-overlay={discussionOpen}>{directoryVisible ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}</button>
        </div>
      </div>
      {/* 打开的产物查看器标签保留在最上层（外部组件渲染） */}
      {viewerTabs.length > 0 && null}
      <Modal open={scopeOpen && Boolean(snapshot?.meta.root)} onClose={() => setScopeOpen(false)} width={560} ariaLabel="项目知识范围">
        <div className="flex items-center gap-2 border-b border-my-line px-5 py-3"><h2 className="flex-1 text-my-md font-semibold">项目知识范围</h2><Button size="sm" variant="ghost" onClick={() => setScopeOpen(false)} aria-label="关闭知识范围"><X size={15} /></Button></div>
        <div className="my-scrollbar max-h-[65vh] overflow-y-auto p-5">{snapshot?.meta.root && <KnowledgeScopeControl key={snapshot.meta.root} root={snapshot.meta.root} />}</div>
      </Modal>
      <Modal open={showMaterials && Boolean(snapshot?.meta.root)} onClose={() => setShowMaterials(false)} width={760} ariaLabel="项目需求材料">
        <div className="flex items-center gap-2 border-b border-my-line px-5 py-3"><h2 className="flex-1 text-my-md font-semibold">需求材料</h2><Button size="sm" variant="ghost" onClick={() => setShowMaterials(false)} aria-label="关闭需求材料"><X size={15} /></Button></div>
        <div className="my-scrollbar max-h-[65vh] overflow-y-auto p-5">{snapshot?.meta.root && <ProductMaterialActions key={snapshot.meta.root} root={snapshot.meta.root} sources={[]} />}</div>
      </Modal>
    </div>
  )
}
