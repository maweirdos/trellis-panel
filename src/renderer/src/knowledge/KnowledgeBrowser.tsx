import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Cloud, FileText, Folder, FolderOpen, Loader2 } from 'lucide-react'
import { clsx } from 'clsx'
import { Button, SearchInput } from '../my/ui'
import { relTime } from '../utils/format'
import { relativePathUnderRoot } from '../reader/reader-paths'
import type { KbBrowseSuccess, KbDoc, KbHit } from '../../../shared/types'
import type { KnowledgeDocument, KnowledgeFolder, KnowledgeFolderTree, KnowledgeSource } from '../../../shared/knowledge-access'
import type { JSX, ReactNode } from 'react'

const PAGE_SIZE = 20
interface FolderNode { name: string; path: string; children: Map<string, FolderNode> }
type RemoteDocument = KnowledgeDocument
interface Props {
  root: string; remote: boolean; query: string; onQuery: (query: string) => void
  serviceAvailable: boolean; noteAvailable: boolean; resultsReady: boolean; remoteScopePending: boolean
  browseDocs: KbDoc[]; localRows: Array<{ doc: KbDoc; hit?: KbHit }>; localTotal: number
  localSnapshotNotice: string | null; localSearchScoped: boolean; localSearchIncomplete: boolean; localSearchHasMore: boolean; localCoverage: string | null; localFolders: string[]; localPaged: boolean; localLegacy: boolean; localPage: number; localHasMore: boolean; localRefresh: number; localRefreshing: boolean
  onLocalFolder: (path: string) => void; onLocalPage: (page: number) => void; browseLocalDirectory: (path: string, page: number) => Promise<KbBrowseSuccess>
  collections: Array<{ id: string; name: string }>; collectionId: string; onCollection: (id: string) => void
  remoteTree: KnowledgeFolderTree | null; remoteTreeError: string | null; onRetryTree: () => void; remoteFolder: string | null; onRemoteFolder: (path: string | null) => void
  remoteDocs: RemoteDocument[]; remotePageReady: boolean; remoteHits: KnowledgeSource[]; remotePage: number; remoteHasMore: boolean
  onRemotePage: (page: number) => void; onIntegrations: () => void; remoteEnabled: boolean; loading: boolean; error: string | null; remoteSearchError: string | null; remoteSearchPending: boolean
  onOpenLocal: (doc: KbDoc) => void; onOpenRemote: (handle: string, title: string) => void
  onBrowse: () => void; onNewNote: () => void; selectedLocal?: string; selectedRemote?: string
  treeVisible: boolean; treeOverlay: boolean; showList: boolean; children: ReactNode
}
function localFolder(root: string, doc: KbDoc): string {
  const path = relativePathUnderRoot(root, doc.path)
  if (path === null) return ''
  return path.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
}
function inFolder(folder: string, selected: string): boolean { return !selected || folder === selected || folder.startsWith(`${selected}/`) }
function makeTree(paths: string[]): FolderNode {
  const root: FolderNode = { name: '', path: '', children: new Map() }
  for (const path of paths) {
    let node = root
    for (const part of path.split('/').filter(Boolean)) {
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, path: node.path ? `${node.path}/${part}` : part, children: new Map() }
        node.children.set(part, child)
      }
      node = child
    }
  }
  return root
}

export function KnowledgeBrowser(props: Props): JSX.Element {
  const [folder, setFolder] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [page, setPage] = useState(1)
  const [treePages, setTreePages] = useState<Record<string, number>>({})
  const [localDirectoryVersion, setLocalDirectoryVersion] = useState(props.localRefresh)
  const [localDirectoryPages, setLocalDirectoryPages] = useState<Record<string, { data?: KbBrowseSuccess; loading?: boolean; error?: string; notice?: string }>>({})
  const directoryGeneration = useRef(0)
  const directoryRequests = useRef<Record<string, number>>({})
  const directorySnapshots = useRef<Record<string, number>>({})
  // Serialize directory reads so refreshes cannot overflow the shared worker queue.
  const directoryQueue = useRef<Promise<void>>(Promise.resolve())
  const directoryOwner = useRef({ root: props.root, browse: props.browseLocalDirectory })
  useEffect(() => { setFolder(''); setExpanded({}); setPage(1); setTreePages({}) }, [props.root])
  useEffect(() => { setExpanded((old) => Object.fromEntries(Object.entries(old).filter(([key]) => !key.startsWith('remote:') && key !== 'remote-root'))) }, [props.collectionId])
  useEffect(() => { setPage(1) }, [props.query, folder])
  const searching = Boolean(props.query.trim())
  const available = Boolean(props.root && props.serviceAvailable)
  const localDocsByFolder = useMemo(() => {
    const groups = new Map<string, KbDoc[]>()
    for (const doc of props.browseDocs) {
      if (relativePathUnderRoot(props.root, doc.path) === null) continue
      const path = localFolder(props.root, doc)
      const docs = groups.get(path) ?? []
      docs.push(doc)
      groups.set(path, docs)
    }
    for (const docs of groups.values()) docs.sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path))
    return groups
  }, [props.browseDocs, props.root])
  const paths = useMemo(() => props.localPaged ? props.localFolders : [...localDocsByFolder.keys()], [props.localPaged, props.localFolders, localDocsByFolder])
  const tree = useMemo(() => makeTree(paths), [paths])
  const localRows = props.localPaged && !searching ? props.localRows : props.localRows.filter(({ doc }) => inFolder(localFolder(props.root, doc), folder))
  const remoteDocs = props.remotePageReady ? props.remoteDocs : []
  const remoteHits = props.remoteHits.filter((source) => !props.collectionId || source.collectionId === props.collectionId)
  const rows = props.remote ? (searching ? (props.resultsReady ? remoteHits : []) : remoteDocs) : (props.resultsReady ? localRows : [])
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const visiblePage = Math.min(page, pages)
  const visibleRows = props.remote || (props.localPaged && !searching) ? rows : rows.slice((visiblePage - 1) * PAGE_SIZE, visiblePage * PAGE_SIZE)
  const selectFolder = (path: string): void => { setFolder(path); props.onLocalFolder(path); props.onBrowse() }
  const loadLocalDirectory = (path: string, page: number): void => {
    const generation = directoryGeneration.current
    const request = (directoryRequests.current[path] ?? 0) + 1
    directoryRequests.current[path] = request
    setLocalDirectoryPages((old) => ({ ...old, [path]: { ...old[path], loading: true, error: undefined } }))
    const valid = (): boolean => generation === directoryGeneration.current && directoryRequests.current[path] === request
    directoryQueue.current = directoryQueue.current.catch(() => undefined).then(async () => {
      if (!valid()) return
      try {
        const data = await props.browseLocalDirectory(path, page)
        if (!valid()) return
        if (data.page !== page) throw new Error('本地服务返回的页码不匹配，请重试')
        const timestampValid = typeof data.snapshotAt === 'number' && Number.isFinite(data.snapshotAt)
        const previous = directorySnapshots.current[path]
        if (page > 1 && (previous === undefined || !timestampValid || previous !== data.snapshotAt)) {
          const notice = previous === undefined || !timestampValid ? '无法验证分页快照，已返回第一页。' : '资料已更新，已返回第一页。'
          setLocalDirectoryPages((old) => ({ ...old, [path]: { loading: true, notice } }))
          loadLocalDirectory(path, 1)
          return
        }
        if (timestampValid) directorySnapshots.current[path] = data.snapshotAt
        else delete directorySnapshots.current[path]
        setLocalDirectoryPages((old) => ({ ...old, [path]: { data, notice: old[path]?.notice } }))
      } catch (error) {
        if (valid()) setLocalDirectoryPages((old) => ({ ...old, [path]: { ...old[path], loading: false, error: error instanceof Error ? error.message : '目录读取失败' } }))
      }
    })
  }
  useEffect(() => {
    directoryGeneration.current += 1
    directoryRequests.current = {}
    const sameOwner = directoryOwner.current.root === props.root && directoryOwner.current.browse === props.browseLocalDirectory
    if (!sameOwner) directorySnapshots.current = {}
    setLocalDirectoryPages((old) => sameOwner ? old : {})
    directoryOwner.current = { root: props.root, browse: props.browseLocalDirectory }
    setLocalDirectoryVersion(props.localRefresh)
    if (!props.remote && props.localPaged) {
      loadLocalDirectory('', 1)
      for (const [path, open] of Object.entries(expanded)) if (open && props.localFolders.includes(path)) loadLocalDirectory(path, 1)
    }
    return () => { directoryGeneration.current += 1 }
  }, [props.root, props.remote, props.localPaged, props.localRefresh, props.browseLocalDirectory])
  const selectRemoteFolder = (path: string | null, browse = true): void => {
    if (props.query) props.onQuery('')
    props.onRemoteFolder(path)
    if (browse) props.onBrowse()
  }
  const renderLocalFiles = (path: string, depth: number): JSX.Element | null => {
    if (props.localPaged) {
      if (props.localRefreshing || localDirectoryVersion !== props.localRefresh || directoryOwner.current.root !== props.root || directoryOwner.current.browse !== props.browseLocalDirectory) return <p className="px-3 py-1 text-my-2xs text-my-tertiary">正在刷新目录…</p>
      const state = localDirectoryPages[path]
      if (!state || state.loading) return <p className="px-3 py-1 text-my-2xs text-my-tertiary">正在读取目录…</p>
      if (state.error && !state.data) return <div className="px-3 py-1 text-my-2xs text-my-warning-text">{state.error} <button type="button" className="underline" onClick={() => loadLocalDirectory(path, 1)}>重试</button></div>
      const data = state.data
      if (!data) return null
      return <div style={{ paddingLeft: `${depth * 14 + 24}px` }} className="pr-2">
        {state.notice && <p role="status" className="py-1 text-my-2xs text-my-tertiary">{state.notice}</p>}
        {state.error && <p role="status" className="py-1 text-my-2xs text-my-warning-text">读取失败：{state.error}；显示上次结果。 <button type="button" className="underline" onClick={() => loadLocalDirectory(path, data.page)}>重试</button></p>}
        {data.docs.map((doc) => <button key={doc.id} type="button" title={doc.path} aria-pressed={props.selectedLocal === doc.id} onClick={() => { setFolder(path); props.onLocalFolder(path); props.onOpenLocal(doc) }} className={clsx('flex w-full items-center gap-2 rounded-my-md py-1.5 text-left text-my-xs hover:bg-my-layer-transparent-hover', props.selectedLocal === doc.id ? 'bg-my-accent-subtle text-my-primary' : 'text-my-secondary')}><FileText size={14} className="shrink-0" /><span className="truncate">{doc.title}</span></button>)}
        <div className="flex flex-wrap items-center gap-2 py-1 text-my-2xs text-my-tertiary"><span>目录第 {data.page} 页 · {data.totalDocs} 条</span><button type="button" disabled={data.page <= 1} onClick={() => loadLocalDirectory(path, data.page - 1)} className="disabled:opacity-40">上一页</button><button type="button" disabled={!data.hasMore} onClick={() => loadLocalDirectory(path, data.page + 1)} className="disabled:opacity-40">下一页</button></div>
      </div>
    }
    const docs = localDocsByFolder.get(path) ?? []
    if (!docs.length) return null
    const totalPages = Math.ceil(docs.length / PAGE_SIZE)
    const current = Math.min(treePages[path] ?? 1, totalPages)
    return <div>
      {docs.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE).map((doc) => <button key={doc.id} type="button" title={doc.path} aria-pressed={props.selectedLocal === doc.id} onClick={() => { setFolder(path); props.onOpenLocal(doc) }} style={{ paddingLeft: `${depth * 14 + 24}px` }} className={clsx('flex w-full items-center gap-2 rounded-my-md py-1.5 pr-2 text-left text-my-xs hover:bg-my-layer-transparent-hover', props.selectedLocal === doc.id ? 'bg-my-accent-subtle text-my-primary' : 'text-my-secondary')}><FileText size={14} className="shrink-0" /><span className="truncate">{doc.title}</span></button>)}
      {totalPages > 1 && <div className="flex items-center gap-2 py-1 pr-2 text-my-2xs text-my-tertiary" style={{ paddingLeft: `${depth * 14 + 24}px` }}><button type="button" disabled={current <= 1} onClick={() => setTreePages((old) => ({ ...old, [path]: current - 1 }))} className="disabled:opacity-40">上一组</button><span>{current} / {totalPages}</span><button type="button" disabled={current >= totalPages} onClick={() => setTreePages((old) => ({ ...old, [path]: current + 1 }))} className="disabled:opacity-40">下一组</button></div>}
    </div>
  }
  const renderRemoteFiles = (path: string, depth: number): JSX.Element => {
    const selected = props.remoteFolder === path
    return <div style={{ paddingLeft: `${depth * 14 + 24}px` }} className="pr-2">
      {!selected ? <p className="py-1 text-my-2xs text-my-tertiary">选择此目录以读取文件</p> : searching ? <p className="py-1 text-my-2xs text-my-tertiary">搜索结果不按目录筛选；选择目录以浏览文件</p> : props.loading || !props.remotePageReady ? <p className="py-1 text-my-2xs text-my-tertiary">{props.error ? '本页读取失败' : '正在读取目录页…'}</p> : <>
        {props.remoteDocs.map((doc) => <button key={doc.sourceHandle} type="button" title={doc.title} aria-pressed={props.selectedRemote === doc.sourceHandle} onClick={() => props.onOpenRemote(doc.sourceHandle, doc.title)} className={clsx('flex w-full items-center gap-2 rounded-my-md py-1.5 text-left text-my-xs hover:bg-my-layer-transparent-hover', props.selectedRemote === doc.sourceHandle ? 'bg-my-accent-subtle text-my-primary' : 'text-my-secondary')}><FileText size={14} className="shrink-0" /><span className="truncate">{doc.title}</span></button>)}
        <div className="flex flex-wrap items-center gap-2 py-1 text-my-2xs text-my-tertiary"><span>目录第 {props.remotePage} 页 · {props.remoteDocs.length} 条</span><button type="button" disabled={props.remotePage <= 1} onClick={() => props.onRemotePage(props.remotePage - 1)} className="disabled:opacity-40">上一页</button><button type="button" disabled={!props.remoteHasMore} onClick={() => props.onRemotePage(props.remotePage + 1)} className="disabled:opacity-40">下一页</button></div>
      </>}
    </div>
  }
  const renderRemoteFolder = (node: KnowledgeFolder, depth: number): JSX.Element => {
    const key = `remote:${node.path}`
    const open = expanded[key] ?? false
    return <div key={node.path}>
      <div className={clsx('flex items-center rounded-my-md pr-2 hover:bg-my-layer-transparent-hover', props.remoteFolder === node.path && 'bg-my-accent-subtle')} style={{ paddingLeft: `${depth * 14 + 8}px` }}>
        <button type="button" className="my-icon-control shrink-0" aria-label={`${open ? '收起' : '展开'}${node.name}`} aria-expanded={open} onClick={() => { setExpanded((old) => ({ ...old, [key]: !open })); if (!open) selectRemoteFolder(node.path, false) }}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-my-xs text-my-secondary" onClick={() => { selectRemoteFolder(node.path); setExpanded((old) => ({ ...old, [key]: true })) }}>{open ? <FolderOpen size={14} /> : <Folder size={14} />}<span className="min-w-0 flex-1 truncate" title={node.path}>{node.name}</span><span className="text-my-2xs text-my-tertiary">{node.totalCount}</span></button>
      </div>
      {open && <>{node.children.map((child) => renderRemoteFolder(child, depth + 1))}{renderRemoteFiles(node.path, depth + 1)}</>}
    </div>
  }
  const renderFolder = (node: FolderNode, depth: number): JSX.Element => {
    const open = expanded[node.path] ?? (!props.localPaged && depth < 1)
    return <div key={node.path}>
      <div className={clsx('flex items-center rounded-my-md pr-2 hover:bg-my-layer-transparent-hover', folder === node.path && 'bg-my-accent-subtle')} style={{ paddingLeft: `${depth * 14 + 8}px` }}>
        <button type="button" className="my-icon-control shrink-0" aria-label={`${open ? '收起' : '展开'}${node.name}`} aria-expanded={open} onClick={() => { setExpanded((old) => ({ ...old, [node.path]: !open })); if (!open && props.localPaged && !localDirectoryPages[node.path]) loadLocalDirectory(node.path, 1) }}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-my-xs text-my-secondary" onClick={() => { selectFolder(node.path); setExpanded((old) => ({ ...old, [node.path]: true })); if (props.localPaged && !localDirectoryPages[node.path]) loadLocalDirectory(node.path, 1) }}>{open ? <FolderOpen size={14} /> : <Folder size={14} />}<span className="truncate" title={node.path}>{node.name}</span></button>
      </div>
      {open && <>{[...node.children.values()].sort((a, b) => a.name.localeCompare(b.name)).map((child) => renderFolder(child, depth + 1))}{renderLocalFiles(node.path, depth + 1)}</>}
    </div>
  }
  return <>
    <aside id="knowledge-directory" hidden={!props.treeVisible} data-overlay={props.treeOverlay} className="knowledge-browser-tree shrink-0 border-r border-my-line bg-my-surface-1" aria-label="文件目录">
      <div className="flex h-my-header shrink-0 items-center border-b border-my-line px-4 text-my-xs font-semibold text-my-tertiary">文件目录</div>
      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!available ? <p className="px-2 py-3 text-my-xs text-my-tertiary">{!props.root ? '请先打开项目' : '项目服务不可用'}</p> : props.remote ? <>
          <div className="px-2 pb-2 text-my-2xs text-my-tertiary">项目绑定的知识库</div>
          {props.collections.map((collection) => <button key={collection.id} type="button" onClick={() => { props.onCollection(collection.id); props.onBrowse() }} className={clsx('flex w-full items-center gap-2 rounded-my-md px-2 py-2 text-left text-my-xs', props.collectionId === collection.id ? 'bg-my-accent-subtle text-my-primary' : 'text-my-secondary hover:bg-my-layer-transparent-hover')}><Cloud size={14} /><span className="truncate" title={collection.name}>{collection.name}</span></button>)}
          {props.collectionId && <div className="mt-2 border-t border-my-line pt-2"><button type="button" className={clsx('w-full rounded-my-md px-3 py-1.5 text-left text-my-xs text-my-secondary', props.remoteFolder === null && 'bg-my-accent-subtle')} onClick={() => selectRemoteFolder(null)}>全部文档</button>{props.remoteTree && <><div className={clsx('flex items-center rounded-my-md', props.remoteFolder === '' && 'bg-my-accent-subtle')}><button type="button" className="my-icon-control shrink-0" aria-label={`${expanded['remote-root'] ? '收起' : '展开'}根目录`} aria-expanded={Boolean(expanded['remote-root'])} onClick={() => { const open = !expanded['remote-root']; setExpanded((old) => ({ ...old, 'remote-root': open })); if (open) selectRemoteFolder('', false) }}>{expanded['remote-root'] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button><button type="button" className="flex-1 py-1.5 text-left text-my-xs text-my-secondary" onClick={() => { selectRemoteFolder(''); setExpanded((old) => ({ ...old, 'remote-root': true })) }}>根目录 {props.remoteTree.rootDocumentCount !== undefined && `· ${props.remoteTree.rootDocumentCount}`}</button></div>{expanded['remote-root'] && renderRemoteFiles('', 0)}{props.remoteTree.folders.map((node) => renderRemoteFolder(node, 0))}</>}{props.remoteTreeError && <p role="status" className="px-3 py-2 text-my-xs text-my-warning-text">{props.remoteTreeError} <button type="button" className="underline" onClick={props.onRetryTree}>重试目录</button></p>}{!props.remoteTree && !props.remoteTreeError && <p className="px-3 py-2 text-my-xs text-my-tertiary">正在读取目录…</p>}</div>}
        </> : <><div className={clsx('flex items-center rounded-my-md', !folder && 'bg-my-accent-subtle')}><button type="button" className="my-icon-control shrink-0" aria-label={`${expanded['local-root'] === false ? '展开' : '收起'}项目资料`} aria-expanded={expanded['local-root'] !== false} onClick={() => setExpanded((old) => ({ ...old, 'local-root': old['local-root'] === false }))}>{expanded['local-root'] === false ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button><button type="button" onClick={() => { selectFolder(''); setExpanded((old) => ({ ...old, 'local-root': true })) }} className="flex flex-1 items-center gap-2 py-2 text-left text-my-xs text-my-secondary"><FolderOpen size={14} />项目资料</button></div>{expanded['local-root'] !== false && (props.localRefreshing || localDirectoryVersion !== props.localRefresh ? <p className="px-3 py-2 text-my-xs text-my-tertiary">正在刷新目录…</p> : <>{[...tree.children.values()].sort((a, b) => a.name.localeCompare(b.name)).map((node) => renderFolder(node, 0))}{renderLocalFiles('', 0)}</>)}{props.localLegacy && <p className="px-3 py-2 text-my-2xs text-my-tertiary">旧版服务仅载入最多 300 篇，目录可能不完整。完整退出并重新打开应用可加载新服务。</p>}</>}
      </div>
    </aside>
    {!props.showList ? props.children : <div className="knowledge-browser-content flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-my-header shrink-0 items-center gap-3 border-b border-my-line px-5">
        <h2 className="min-w-0 flex-1 truncate text-my-md font-semibold text-my-primary">{(props.remote ? props.remoteFolder?.split('/').pop() : folder.split('/').pop()) || (props.remote ? props.collections.find((c) => c.id === props.collectionId)?.name || '知识库' : '项目资料')}</h2>
        <div className="w-64 min-w-0 max-w-[40%]">{available ? <SearchInput value={props.query} onChange={props.onQuery} placeholder={props.remote ? '搜索知识库…' : '搜索资料…'} /> : <input className="my-input w-full" disabled aria-label={props.remote ? '搜索知识库' : '搜索资料'} placeholder={props.remote ? '搜索知识库…' : '搜索资料…'} />}</div>
        {!props.remote && <Button size="sm" variant="outline" disabled={!props.noteAvailable} onClick={props.onNewNote}>新建笔记</Button>}
      </div>
      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-[1000px] px-5 py-5">
        {!available ? <div role="status" className="py-12 text-center text-my-sm text-my-tertiary">{!props.root && <p>尚未打开项目，请先打开项目。</p>}{!props.serviceAvailable && <p>桌面项目服务不可用，请在桌面应用中打开项目。</p>}</div> : <>
        <p className="pb-3 text-my-xs text-my-tertiary">{props.remote ? (props.remoteFolder === null ? '全部文档' : props.remoteFolder || '根目录') : (folder || '当前项目')}</p>
        {props.remote && searching && <p className="pb-3 text-my-xs text-my-tertiary">搜索项目绑定范围{props.collectionId ? '，当前列表按所选知识库筛选' : ''}；搜索不按目录筛选。</p>}
        {props.remote && !searching && props.collectionId && <p className="pb-3 text-my-xs text-my-tertiary">当前第 {props.remotePage} 页{props.remoteFolder === null ? ' · 全部文档' : ' · 所选目录'}。</p>}
        {!props.remote && !props.localPaged && props.localTotal > props.browseDocs.length && !searching && <p className="pb-3 text-my-xs text-my-tertiary">已载入 {props.browseDocs.length} / {props.localTotal} 篇，目录和列表仅覆盖已载入资料。</p>}
        {!props.remote && props.localSnapshotNotice && <p role="status" className="pb-3 text-my-xs text-my-tertiary">{props.localSnapshotNotice}</p>}
        {!props.remote && props.localCoverage && <p role="status" className="pb-3 text-my-xs text-my-warning-text">{props.localCoverage}</p>}
        {!props.remote && searching && Boolean(folder) && !props.localSearchScoped && <p role="status" className="pb-3 text-my-xs text-my-warning-text">当前服务先返回全项目的最多 80 条命中，再筛选此目录，可能遗漏结果。</p>}
        {!props.remote && searching && props.localSearchIncomplete && <p role="status" className="pb-3 text-my-xs text-my-warning-text">目录搜索未能覆盖全部资料，结果可能不完整。</p>}
        {!props.remote && searching && props.localSearchHasMore && <p role="status" className="pb-3 text-my-xs text-my-tertiary">匹配超过 80 条，请缩小关键词范围。</p>}
        {!props.remote && searching && !props.localSearchHasMore && props.localRows.length >= 80 && <p className="pb-3 text-my-xs text-my-tertiary">本地搜索最多返回 80 条结果，请缩小关键词范围。</p>}
        {!props.remote && searching && !folder && props.remoteSearchPending && <div role="status" className="pb-3 text-my-xs text-my-tertiary">正在检索远端知识…</div>}
        {props.remoteSearchError && !folder && <div role="alert" className="mb-3 rounded-my-lg border border-my-line-warning bg-my-warning-subtle p-3 text-my-xs text-my-warning-text">远端检索未完成：{props.remoteSearchError}</div>}
        {props.error && <div role="alert" className="mb-3 rounded-my-lg border border-my-line-warning bg-my-warning-subtle p-3 text-my-xs text-my-warning-text">{props.error}</div>}
        <div className="flex items-center border-b border-my-line px-3 pb-2 text-my-xs text-my-tertiary"><span className="flex-1">名称</span><span className="w-28 text-right">来源 / 更新</span></div>
        {visibleRows.map((row) => {
          if (!props.remote) {
            const { doc, hit } = row as { doc: KbDoc; hit?: KbHit }
            return <button key={doc.id} type="button" onClick={() => props.onOpenLocal(doc)} aria-pressed={props.selectedLocal === doc.id} className="flex w-full items-center gap-3 border-b border-my-line px-3 py-3 text-left hover:bg-my-layer-1"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-my-md bg-my-layer-2 text-my-icon-tertiary"><FileText size={17} /></span><span className="min-w-0 flex-1"><span className="my-item-title block truncate">{doc.title}</span><span className="my-item-description block truncate">{hit ? hit.snippet.replace(/[\u0000\u0001]/g, '') : localFolder(props.root, doc) || doc.name}</span></span><span className="my-item-description w-28 shrink-0 text-right">{relTime(doc.mtime)}</span></button>
          }
          const item = row as RemoteDocument | KnowledgeSource
          const handle = item.sourceHandle
          const description = 'text' in item ? item.text : `${item.fileType} · ${item.parseStatus || '状态未知'}`
          return <button key={handle} type="button" onClick={() => props.onOpenRemote(handle, item.title)} aria-pressed={props.selectedRemote === handle} className="flex w-full items-center gap-3 border-b border-my-line px-3 py-3 text-left hover:bg-my-layer-1"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-my-md bg-my-layer-2 text-my-icon-tertiary"><FileText size={17} /></span><span className="min-w-0 flex-1"><span className="my-item-title block truncate">{item.title}</span><span className="my-item-description block truncate">{description}</span></span><span className="my-item-description w-28 shrink-0 truncate text-right">{props.collections.find((c) => c.id === item.collectionId)?.name || item.collectionId || '知识库'}</span></button>
        })}
        {!props.remote && searching && !folder && props.remoteHits.length > 0 && <div className="mt-5"><h3 className="border-b border-my-line px-3 pb-2 text-my-xs font-medium text-my-tertiary">知识库检索结果</h3>{props.remoteHits.map((item) => <button key={item.sourceHandle} type="button" onClick={() => props.onOpenRemote(item.sourceHandle, item.title)} className="flex w-full items-center gap-3 border-b border-my-line px-3 py-3 text-left hover:bg-my-layer-1"><Cloud size={17} className="shrink-0 text-my-icon-tertiary" /><span className="min-w-0 flex-1"><span className="my-item-title block truncate">{item.title}</span><span className="my-item-description block truncate">{item.text}</span></span></button>)}</div>}
        {props.remote && !props.remoteEnabled && !props.remoteScopePending && !props.error && <div className="py-6 text-center text-my-xs text-my-tertiary">未绑定可用的项目知识库 <Button size="sm" variant="outline" onClick={props.onIntegrations}>到集成接入并绑定项目</Button></div>}
        {(props.loading || (props.remote && props.remoteScopePending && !props.error) || (!props.remote && !props.resultsReady && !props.error) || (props.remote && props.remoteEnabled && searching && !props.resultsReady && !props.error) || (props.remote && !searching && Boolean(props.collectionId) && !props.remotePageReady && !props.error)) && <div className="flex items-center gap-2 py-6 text-my-xs text-my-tertiary"><Loader2 size={14} className="animate-spin" />正在读取…</div>}
        {!props.loading && !props.error && (!props.remote ? props.resultsReady : props.remoteEnabled && !props.remoteScopePending && (searching ? props.resultsReady : props.remotePageReady)) && rows.length === 0 && (props.remote || !searching || Boolean(folder) || (!props.remoteSearchPending && !props.remoteSearchError && props.remoteHits.length === 0)) && <div className="py-12 text-center text-my-sm text-my-tertiary">{props.remote && !props.collectionId && !searching ? '选择一个知识库浏览文档' : !props.remote && searching && folder && !props.localSearchScoped ? '已返回的结果中没有此目录的匹配；搜索可能遗漏内容。' : !props.remote && props.localSearchIncomplete ? '已搜索的资料中没有匹配内容，搜索范围不完整。' : !props.remote && props.localCoverage ? '已载入资料中没有匹配内容' : '当前范围没有匹配的资料'}</div>}
        {(!props.remote ? props.resultsReady : searching ? props.resultsReady : props.remotePageReady) && <div className="flex flex-wrap items-center gap-2 py-4 text-my-xs text-my-tertiary"><span className="mr-auto">{!props.remote && props.localPaged && !searching ? `当前页 ${rows.length} 条 · 共 ${props.localTotal} 条` : `当前列表 ${rows.length} 条`}</span>{!props.remote && (!props.localPaged || searching) && pages > 1 && <><Button size="sm" variant="ghost" disabled={visiblePage <= 1} onClick={() => setPage(visiblePage - 1)}>上一组</Button><span>{visiblePage} / {pages}</span><Button size="sm" variant="ghost" disabled={visiblePage >= pages} onClick={() => setPage(visiblePage + 1)}>下一组</Button></>}{!props.remote && props.localPaged && !searching && <><Button size="sm" variant="outline" disabled={props.loading || props.localPage <= 1} onClick={() => props.onLocalPage(props.localPage - 1)}>上一页</Button><span>第 {props.localPage} 页</span><Button size="sm" variant="outline" disabled={props.loading || !props.localHasMore} onClick={() => props.onLocalPage(props.localPage + 1)}>下一页</Button></>}{props.remote && !searching && props.collectionId && <><Button size="sm" variant="outline" disabled={props.loading || props.remotePage <= 1} onClick={() => props.onRemotePage(props.remotePage - 1)}>上一页</Button><span>远端第 {props.remotePage} 页</span><Button size="sm" variant="outline" disabled={props.loading || !props.remoteHasMore} onClick={() => props.onRemotePage(props.remotePage + 1)}>下一页</Button></>}</div>}
        </>}
      </div></div>
    </div>}
  </>
}
