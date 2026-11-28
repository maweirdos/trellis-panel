import { useMemo, useState, type JSX } from 'react'
import { ChevronDown, ChevronRight, FileCode, Folder, FolderOpen, GitCompare } from 'lucide-react'
import { Button } from '../my/ui'
import {
  buildChangedFileTree,
  extractRunChangedFiles,
  type ChangedFileTreeNode,
  type TurnChangedFileEntry,
} from './turnChangedFiles'
import './conversation-enhancements.css'

export {
  buildChangedFileTree,
  extractRunChangedFiles,
  type ChangedFileTreeNode,
  type TurnChangedFileEntry,
}

const STATUS_CODE: Record<TurnChangedFileEntry['kind'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
}

export interface ChangedFilesTreeProps {
  readonly runId: string
  readonly files: readonly TurnChangedFileEntry[]
  readonly onOpenTurnDiff?: (runId: string) => void
  readonly onOpenFile?: (path: string) => void
}

export function ChangedFilesTree({
  runId,
  files,
  onOpenTurnDiff,
  onOpenFile,
}: ChangedFilesTreeProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(() => files.length <= 8)
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set())
  const tree = useMemo(() => buildChangedFileTree(files), [files])
  const totals = useMemo(
    () => files.reduce(
      (acc, file) => ({ additions: acc.additions + file.additions, deletions: acc.deletions + file.deletions }),
      { additions: 0, deletions: 0 },
    ),
    [files],
  )

  if (files.length === 0) return null

  const toggleDir = (fullPath: string): void => {
    setCollapsedDirs((current) => {
      const next = new Set(current)
      if (next.has(fullPath)) next.delete(fullPath)
      else next.add(fullPath)
      return next
    })
  }

  const renderNodes = (nodes: readonly ChangedFileTreeNode[], depth: number): JSX.Element[] =>
    nodes.map((node) => {
      if (node.kind === 'directory') {
        const isOpen = !collapsedDirs.has(node.fullPath)
        return (
          <li key={`dir:${node.fullPath}`}>
            <button
              type="button"
              className="conversation-changed-tree-row"
              style={{ paddingInlineStart: `${depth * 14 + 8}px` }}
              aria-expanded={isOpen}
              onClick={() => toggleDir(node.fullPath)}
            >
              {isOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
              {isOpen ? <FolderOpen size={13} aria-hidden="true" /> : <Folder size={13} aria-hidden="true" />}
              <span className="truncate font-mono text-my-xs text-my-secondary">{node.name}</span>
            </button>
            {isOpen && <ul className="conversation-changed-tree-list">{renderNodes(node.children, depth + 1)}</ul>}
          </li>
        )
      }
      const { file } = node
      const clickable = Boolean(onOpenFile && file.kind !== 'deleted')
      return (
        <li key={`file:${file.path}`}>
          <button
            type="button"
            className="conversation-changed-tree-row"
            style={{ paddingInlineStart: `${depth * 14 + 8}px` }}
            disabled={!clickable}
            title={file.path}
            onClick={() => onOpenFile?.(file.path)}
          >
            <span className="conversation-checkpoint-file-status" data-kind={file.kind}>
              {STATUS_CODE[file.kind]}
            </span>
            <FileCode size={13} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-my-xs text-my-primary">{node.name}</span>
            {(file.additions > 0 || file.deletions > 0) && (
              <span className="conversation-project-stats">
                <span>+{file.additions}</span>
                <span>−{file.deletions}</span>
              </span>
            )}
          </button>
        </li>
      )
    })

  return (
    <section className="conversation-changed-tree" aria-label={`本轮改动 ${files.length} 个文件`}>
      <header className="conversation-changed-tree-header">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-my-xs font-medium text-my-primary"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
          <span className="tabular-nums">本轮改动 {files.length} 个文件</span>
          {(totals.additions > 0 || totals.deletions > 0) && (
            <span className="conversation-project-stats">
              <span>+{totals.additions}</span>
              <span>−{totals.deletions}</span>
            </span>
          )}
        </button>
        {onOpenTurnDiff && (
          <Button size="sm" variant="ghost" onClick={() => onOpenTurnDiff(runId)}>
            <GitCompare size={12} aria-hidden="true" />
            查看差异
          </Button>
        )}
      </header>
      {expanded && (
        <ul className="conversation-changed-tree-list conversation-changed-tree-body">
          {renderNodes(tree, 0)}
        </ul>
      )}
    </section>
  )
}
