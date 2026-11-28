import { useState, type JSX } from 'react'
import { clsx } from 'clsx'
import { api, hasIpc } from '../../api'
import { Tabs } from '../ui'
import { HistoryView } from './HistoryView'
import { WorkspaceView } from './WorkspaceView'

function GitViewerSession({ root }: { root: string | null }): JSX.Element {
  const [view, setView] = useState<'workspace' | 'history'>('workspace')
  const canRead = hasIpc && root !== null
  const hasHistoryApi = hasIpc && typeof api.devtoolsGitHistory === 'function'
  const browsing = canRead && (view === 'workspace' || hasHistoryApi)
  return <section aria-label="只读 Git" className={clsx('my-git-viewer my-card p-4', browsing && 'flex h-full min-h-0 flex-col')}>
    <h2 className="mb-2 shrink-0 text-my-md font-medium text-my-primary">Git（只读）</h2>
    <div className="mb-3 shrink-0">
      <Tabs tabs={[{ id: 'workspace', label: '工作区' }, { id: 'history', label: '历史' }]} active={view} onChange={setView} ariaLabel="Git 视图" />
    </div>
    {!canRead ? <p className="my-git-notice my-item-description">{!hasIpc ? '当前为浏览器预览，未连接本机 Git 桥接。' : '请先打开项目，再查看 Git 记录。'}</p>
      : <div key={view} className="my-subview-stage min-h-0 flex-1 flex flex-col">
        {view === 'workspace' ? <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto"><WorkspaceView /></div>
          : !hasHistoryApi ? <p className="my-git-notice my-item-description">当前桥接不支持历史读取，请重新启动应用。</p>
            : <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto"><HistoryView root={root} /></div>}
      </div>}
  </section>
}

/** Root changes remount all selections and invalidate the old session's requests. */
export function GitViewer({ root }: { root: string | null }): JSX.Element {
  return <GitViewerSession key={root ?? 'no-project'} root={root} />
}
