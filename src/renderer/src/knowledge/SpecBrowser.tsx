import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Link2 } from 'lucide-react'
import { clsx } from 'clsx'
import { Button, SearchInput } from '../my/ui'
import { relTime } from '../utils/format'
import type { JSX, ReactNode } from 'react'
import type { DocSearchHit, ProjectSnapshot, SpecNode } from '../../../shared/types'

interface DocumentItem {
  path: string
  name: string
  group: DocSearchHit['group']
  size: number
  mtime: number
  snippet?: string
}
interface Directory {
  id: string
  name: string
  children: Directory[]
  files: DocumentItem[]
}
interface Props {
  snapshot: ProjectSnapshot | null
  query: string
  onQuery: (query: string) => void
  scope: 'all' | 'spec' | 'workspace'
  onScope: (scope: 'all' | 'spec' | 'workspace') => void
  hits: DocSearchHit[]
  searching: boolean
  error: string | null
  selectedPath?: string
  refCount: Record<string, number> | null
  onRefreshReferences: () => void
  onOpen: (doc: DocumentItem) => void
  showList: boolean
  onBrowse: () => void
  treeVisible: boolean
  children: ReactNode
}

const PAGE_SIZE = 30
const groupLabels: Record<DocSearchHit['group'], string> = { spec: '规范文档', workspace: '工作区日志', shared: '共享索引' }

function specDirectory(node: SpecNode): Directory {
  const children = node.children ?? []
  return {
    id: node.path, name: node.name,
    children: children.filter((item) => item.type === 'dir').map(specDirectory),
    files: children.filter((item) => item.type === 'file').map((item) => ({ path: item.path, name: item.name, group: 'spec', size: item.size ?? 0, mtime: item.mtime ?? 0 }))
  }
}

function Snippet({ text }: { text: string }): JSX.Element {
  return <>{text.split(/[\u0000\u0001]/).map((part, i) => i % 2 ? <mark key={i} className="rounded-my-sm bg-my-accent-subtle text-my-accent-text">{part}</mark> : <span key={i}>{part}</span>)}</>
}

export function SpecBrowser(props: Props): JSX.Element {
  const [folder, setFolder] = useState('spec')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ spec: true })
  const [page, setPage] = useState(1)
  const [treePages, setTreePages] = useState<Record<string, number>>({})
  const roots = useMemo<Directory[]>(() => {
    const nodes = props.snapshot?.spec ?? []
    return [
      { id: 'spec', name: '规范文档', children: nodes.filter((n) => n.type === 'dir').map(specDirectory), files: nodes.filter((n) => n.type === 'file').map((n) => ({ path: n.path, name: n.name, group: 'spec', size: n.size ?? 0, mtime: n.mtime ?? 0 })) },
      { id: 'workspace', name: '工作区日志', children: (props.snapshot?.developers ?? []).map((developer) => ({ id: `workspace:${developer.path}`, name: developer.name, children: [], files: [...developer.journals, ...developer.otherFiles].map((file) => ({ ...file, group: 'workspace' as const })) })), files: [] },
      { id: 'shared', name: '共享索引', children: [], files: (props.snapshot?.sharedWorkspaceFiles ?? []).map((file) => ({ ...file, group: 'shared' as const })) }
    ]
  }, [props.snapshot])
  useEffect(() => { setFolder('spec'); setExpanded({ spec: true }); setTreePages({}); setPage(1) }, [props.snapshot?.meta.root])
  useEffect(() => { setPage(1) }, [folder, props.query, props.scope])
  const findDirectory = (nodes: Directory[], id: string): Directory | undefined => {
    for (const node of nodes) { if (node.id === id) return node; const child = findDirectory(node.children, id); if (child) return child }
    return undefined
  }
  const current = findDirectory(roots, folder) ?? roots[0]
  const searchActive = Boolean(props.query.trim())
  const rows: Array<{ directory: Directory } | { document: DocumentItem }> = searchActive
    ? (props.searching ? [] : props.hits.map((document) => ({ document })))
    : [...current.children.map((directory) => ({ directory })), ...current.files.map((document) => ({ document }))]
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const visiblePage = Math.min(page, pages)
  const selectFolder = (id: string): void => { setFolder(id); if (searchActive) props.onQuery(''); props.onBrowse() }
  const renderDirectory = (node: Directory, depth: number): JSX.Element => {
    const open = Boolean(expanded[node.id])
    const treePage = Math.min(treePages[node.id] ?? 1, Math.max(1, Math.ceil(node.files.length / PAGE_SIZE)))
    return <div key={node.id}>
      <div className={clsx('flex items-center rounded-my-md pr-2 hover:bg-my-layer-transparent-hover', folder === node.id && 'bg-my-accent-subtle')} style={{ paddingLeft: `${depth * 14 + 8}px` }}>
        <button type="button" className="my-icon-control shrink-0" aria-label={`${open ? '收起' : '展开'}${node.name}`} aria-expanded={open} onClick={() => setExpanded((old) => ({ ...old, [node.id]: !open }))}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-my-xs text-my-secondary" onClick={() => { selectFolder(node.id); setExpanded((old) => ({ ...old, [node.id]: true })) }}>{open ? <FolderOpen size={14} /> : <Folder size={14} />}<span className="truncate">{node.name}</span></button>
      </div>
      {open && <>{node.children.map((child) => renderDirectory(child, depth + 1))}<div style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }} className="pr-2">
        {node.files.slice((treePage - 1) * PAGE_SIZE, treePage * PAGE_SIZE).map((file) => <button key={file.path} type="button" title={file.path} aria-pressed={props.selectedPath === file.path && !props.showList} onClick={() => props.onOpen(file)} className={clsx('flex w-full items-center gap-2 rounded-my-md py-1.5 text-left text-my-xs hover:bg-my-layer-transparent-hover', props.selectedPath === file.path && !props.showList ? 'bg-my-accent-subtle text-my-primary' : 'text-my-secondary')}><FileText size={14} className="shrink-0" /><span className="truncate">{file.name}</span></button>)}
        {node.files.length > PAGE_SIZE && <div className="flex items-center gap-2 py-1 text-my-2xs text-my-tertiary"><button type="button" disabled={treePage <= 1} onClick={() => setTreePages((old) => ({ ...old, [node.id]: treePage - 1 }))} className="disabled:opacity-40">上一页</button><span>{treePage} / {Math.ceil(node.files.length / PAGE_SIZE)}</span><button type="button" disabled={treePage * PAGE_SIZE >= node.files.length} onClick={() => setTreePages((old) => ({ ...old, [node.id]: treePage + 1 }))} className="disabled:opacity-40">下一页</button></div>}
      </div></>}
    </div>
  }
  return <>
    <aside id="spec-directory" hidden={!props.treeVisible} className="knowledge-browser-tree shrink-0 border-r border-my-line bg-my-surface-1" aria-label="文件目录">
      <div className="flex h-my-header shrink-0 items-center border-b border-my-line px-4 text-my-xs font-semibold text-my-tertiary">文件目录<button type="button" onClick={props.onRefreshReferences} className="my-icon-control ml-auto" aria-label="刷新引用统计" title="刷新引用统计"><Link2 size={13} /></button></div>
      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">{props.snapshot ? roots.map((root) => renderDirectory(root, 0)) : <p className="px-2 py-3 text-my-xs text-my-tertiary">请先打开项目</p>}</div>
    </aside>
    {props.showList && <div className="knowledge-browser-content flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-my-header shrink-0 items-center gap-3 border-b border-my-line px-5"><h2 className="min-w-0 flex-1 truncate text-my-md font-semibold text-my-primary">{searchActive ? '搜索结果' : current.name}</h2><div className="w-64 min-w-0 max-w-[40%]"><SearchInput value={props.query} onChange={props.onQuery} placeholder="搜索规范、日志与共享文档…" /></div></div>
      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-[1000px] px-5 py-5">
        {searchActive && <div className="flex items-center gap-1 pb-3">{([['all', '全部'], ['spec', '规范'], ['workspace', '工作区']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={props.scope === value} onClick={() => props.onScope(value)} className={clsx('rounded-my-md px-2 py-1 text-my-xs', props.scope === value ? 'bg-my-accent-subtle text-my-accent-text' : 'text-my-tertiary hover:bg-my-layer-1-hover')}>{label}</button>)}</div>}
        {props.error && <p role="alert" className="mb-3 rounded-my-lg border border-my-line-warning bg-my-warning-subtle p-3 text-my-xs text-my-warning-text">{props.error}</p>}
        <div className="flex items-center border-b border-my-line px-3 pb-2 text-my-xs text-my-tertiary"><span className="flex-1">名称</span><span className="w-28 text-right">来源 / 更新</span></div>
        {searchActive && !props.searching && props.hits.length === 60 && <p role="status" className="pb-3 text-my-xs text-my-tertiary">最多显示 60 条结果，请缩小关键词范围。</p>}
        {rows.slice((visiblePage - 1) * PAGE_SIZE, visiblePage * PAGE_SIZE).map((row) => 'directory' in row ? <button key={row.directory.id} type="button" onClick={() => { selectFolder(row.directory.id); setExpanded((old) => ({ ...old, [row.directory.id]: true })) }} className="flex w-full items-center gap-3 border-b border-my-line px-3 py-3 text-left hover:bg-my-layer-1"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-my-md bg-my-layer-2 text-my-icon-tertiary"><Folder size={17} /></span><span className="min-w-0 flex-1 truncate text-my-sm font-medium text-my-primary">{row.directory.name}</span><ChevronRight size={14} className="text-my-icon-tertiary" /></button> : ((doc) => <button key={`${doc.group}:${doc.path}`} type="button" title={doc.path} onClick={() => props.onOpen(doc)} className="flex w-full items-center gap-3 border-b border-my-line px-3 py-3 text-left hover:bg-my-layer-1"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-my-md bg-my-layer-2 text-my-icon-tertiary"><FileText size={17} /></span><span className="min-w-0 flex-1"><span className="block truncate text-my-sm font-medium text-my-primary">{doc.name}</span><span className="block truncate text-my-xs text-my-tertiary">{doc.snippet ? <Snippet text={doc.snippet} /> : doc.path}</span></span><span className="w-28 shrink-0 text-right text-my-xs text-my-tertiary">{searchActive ? groupLabels[doc.group] : doc.mtime ? relTime(doc.mtime) : ''}{doc.group === 'spec' && props.refCount?.[doc.path] !== undefined && <span className="block">引用 {props.refCount[doc.path]}</span>}</span></button>)(row.document))}
        {searchActive && props.searching && <div role="status" className="py-6 text-my-xs text-my-tertiary">正在检索…</div>}
        {!props.searching && !props.error && rows.length === 0 && <div className="py-12 text-center text-my-sm text-my-tertiary">{props.snapshot ? '当前范围没有匹配的文档' : '尚未打开项目'}</div>}
        <div className="flex items-center gap-2 py-4 text-my-xs text-my-tertiary"><span className="mr-auto">当前列表 {rows.length} 条</span>{pages > 1 && <><Button size="sm" variant="ghost" disabled={visiblePage <= 1} onClick={() => setPage(visiblePage - 1)}>上一页</Button><span>{visiblePage} / {pages}</span><Button size="sm" variant="ghost" disabled={visiblePage >= pages} onClick={() => setPage(visiblePage + 1)}>下一页</Button></>}</div>
      </div></div>
    </div>}
    <div hidden={props.showList} className="min-h-0 min-w-0 flex-1">{props.children}</div>
  </>
}
