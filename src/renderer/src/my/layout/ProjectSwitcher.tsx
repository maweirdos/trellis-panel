import type { JSX } from 'react'
import { Check, ChevronDown, FolderOpen } from 'lucide-react'
import { clsx } from 'clsx'
import { useApp } from '../../store'
import { useMy } from '../store'
import { Dropdown, DropdownHeader } from '../ui'
import { projectChoices, projectNameFromPath, projectRootKey } from '../navigation'

/** The only project selector in the normal window; names never come from demo data. */
export function ProjectSwitcher({ keepPage = false }: { keepPage?: boolean }): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const recent = useApp((s) => s.settings?.recentProjects)
  const openError = useApp((s) => s.openError)
  const openProjectPath = useApp((s) => s.openProjectPath)
  const pickAndOpen = useApp((s) => s.pickAndOpen)
  const canOpen = useMy((s) => s.canOpenLocalProject)
  const root = snapshot?.meta.root ?? null
  const name = snapshot?.meta.name || (root ? projectNameFromPath(root) : '选择本机工程')
  const choices = projectChoices(root, recent ?? [])
  return (
    <Dropdown width={340} className="no-drag min-w-0" trigger={({ open, toggle }) => (
      <button type="button" aria-label={root ? `选择本机工程，当前${name}` : '选择本机工程'} aria-expanded={open} onClick={toggle}
        title={root ?? '未绑定本地项目'}
        className="my-project-switcher flex h-my-control min-w-0 items-center gap-2 rounded-my-md px-2.5 text-my-md text-my-primary transition-colors hover:bg-my-layer-transparent-hover">
        <span className="my-project-switcher-name max-w-[260px] truncate font-medium">{name}</span>
        <ChevronDown size={14} strokeWidth={1.7} className={clsx('shrink-0 text-my-icon-tertiary transition-transform', open && 'rotate-180')} />
      </button>
    )}>
      {(close) => (
        <div>
          <DropdownHeader>最近打开的本机工程</DropdownHeader>
          <div className="my-scrollbar max-h-[40vh] px-1">
            {choices.length === 0 && <p className="my-item-description px-3 py-3">尚无项目记录</p>}
            {choices.map((path) => (
              <button key={projectRootKey(path)} type="button" disabled={!canOpen}
                className={clsx('flex w-full items-center gap-3 rounded-my-md px-2.5 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-50',
                  projectRootKey(path) === projectRootKey(root) ? 'bg-my-layer-1-selected text-my-primary' : 'text-my-secondary hover:bg-my-layer-1-hover')}
                onClick={() => { if (projectRootKey(path) !== projectRootKey(root)) void openProjectPath(path, { keepPage }); close() }}>
                <FolderOpen size={17} strokeWidth={1.7} className="shrink-0 text-my-icon-secondary" />
                <span className="min-w-0 flex-1">
                  <span className={clsx('my-item-title block truncate', projectRootKey(path) === projectRootKey(root) && 'text-my-primary')} title={path}>{projectRootKey(path) === projectRootKey(root) ? name : projectNameFromPath(path)}</span>
                  <span className={clsx('my-item-description mt-0.5 block truncate', projectRootKey(path) === projectRootKey(root) && 'text-my-secondary')} title={path}>{path}</span>
                </span>
                {projectRootKey(path) === projectRootKey(root) && <Check size={15} className="shrink-0 text-my-icon-accent" />}
              </button>
            ))}
          </div>
          <div className="my-1 border-t border-my-line" />
          <div className="px-1">
            <button type="button" disabled={!canOpen} onClick={() => { void pickAndOpen({ keepPage }); close() }}
              className="flex min-h-9 w-full items-center gap-3 rounded-my-md px-2.5 py-2 text-left text-my-md text-my-secondary hover:bg-my-layer-1-hover disabled:cursor-not-allowed disabled:opacity-50">
              <FolderOpen size={17} strokeWidth={1.7} />打开本机工程…
            </button>
          </div>
          {!canOpen && <p className="my-item-description px-3 pb-2">浏览器预览不读取本机目录，请在桌面应用中打开项目。</p>}
          {openError && <p role="status" className="px-3 pb-2 text-my-xs text-my-danger-text">{openError}</p>}
        </div>
      )}
    </Dropdown>
  )
}
