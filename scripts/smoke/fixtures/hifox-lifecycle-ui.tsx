import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HiFoxApp } from '../../../src/renderer/src/hifox/HiFoxApp'
import { useHifox, type HifoxModule } from '../../../src/renderer/src/hifox/store'
import { openLocalWork } from '../../../src/renderer/src/hifox/local-work'
import { api } from '../../../src/renderer/src/api'
import { useApp, type Page } from '../../../src/renderer/src/store'
import { useMy } from '../../../src/renderer/src/my/store'
import { IssuePeek } from '../../../src/renderer/src/my/pages/IssuePeek'
import { MyApp } from '../../../src/renderer/src/my/layout/MyApp'
import { DialogHost } from '../../../src/renderer/src/components/Dialogs'
import { Toasts } from '../../../src/renderer/src/components/Toasts'
import { dispatchEscKey } from '../../../src/renderer/src/utils/esc-layer'
import type { HifoxWorkspaceContext } from '../../../src/shared/hifox-remote'
import type { HifoxWorkLocal } from '../../../src/shared/hifox-work'
import type { UiFontSize } from '../../../src/renderer/src/my/appearance'

let enableShell: (() => void) | undefined
const fixture = {
  state: () => useHifox.getState(),
  bootstrap: () => useHifox.getState().bootstrap(),
  setModule: (module: HifoxModule) => useHifox.getState().setModule(module),
  openTask: (id: string | null) => useHifox.getState().openTask(id),
  context: (context: HifoxWorkspaceContext) => useHifox.setState({ workspaceContext: context }),
  refreshNative: async () => { await useApp.getState().refresh(); useMy.getState().syncFromSnapshot() },
  openNative: (taskId: string, local: HifoxWorkLocal) => openLocalWork(useHifox.getState().workspaceContext.key, taskId, local),
  clearNative: () => { useApp.setState({ snapshot: null, openTaskDir: null, taskExpandOrigin: null }); useHifox.setState({ workReturn: null }) },
  page: (page: Page) => useApp.getState().setPage(page),
  nativeState: () => { const state = useApp.getState(); return { page: state.page, navigationRevision: state.navigationRevision, root: state.snapshot?.meta.root, tasks: state.snapshot?.tasks.map((task) => task.dirName), openTaskDir: state.openTaskDir, taskExpandOrigin: state.taskExpandOrigin } },
  nativeIssue: (id: string) => useMy.getState().openIssue(id),
  shell: () => { useMy.getState().closeIssue(); useHifox.getState().openTask(null); useApp.getState().setPage('hifox'); enableShell?.() },
  returnLease: (taskId: string, nativeA: string, nativeB: string | null) => {
    const team = useHifox.getState(), app = useApp.getState()
    const task = team.snapshot?.tasks.find((task) => task.id === taskId)
    const projectRoot = app.snapshot?.meta.root
    if (!task || !projectRoot) throw Error('Missing native lease source')
    team.openTask(null)
    useHifox.setState({ workReturn: { workspaceKey: team.workspaceContext.key, actorId: team.workspaceContext.actorId, epoch: team.workspaceContext.epoch, taskId, taskCreatedAt: task.createdAt, projectRoot, taskDir: nativeA } })
    app.expandTaskWorkspace({ fromPage: 'hifox', taskDir: nativeA, archived: false, scrollTop: 0 })
    if (nativeB) app.showTask(nativeB)
    const leaseClearedAtSelection = useHifox.getState().workReturn === null
    const returned = app.returnFromWorkspace()
    const selected = useApp.getState().openTaskDir
    // Close the native preview in the same turn; this test owns lease/return semantics.
    app.showTask(null)
    return { leaseClearedAtSelection, returned, selected }
  },
  appearance: (theme: 'light' | 'dark', fontSize: UiFontSize) => useMy.setState({ theme, fontSize })
}
declare global { interface Window { hifoxLifecycle: typeof fixture } }
window.hifoxLifecycle = fixture
useApp.getState().setPage('hifox')

function Fixture(): JSX.Element {
  const [shell, setShell] = useState(false)
  enableShell = () => setShell(true)
  const theme = useMy((state) => state.theme)
  const fontSize = useMy((state) => state.fontSize)
  useEffect(() => {
    const off = api.onSnapshotUpdated((snapshot) => { useApp.getState().setSnapshot(snapshot); useMy.getState().syncFromSnapshot() })
    const listener = (event: KeyboardEvent): void => { if (event.key === 'Escape' && dispatchEscKey()) { event.preventDefault(); event.stopPropagation() } }
    window.addEventListener('keydown', listener)
    return () => { off(); window.removeEventListener('keydown', listener) }
  }, [])
  return <div className="my-root hifox-fixture-root" data-my-theme={theme} data-my-font-size={fontSize}>{shell ? <MyApp /> : <><HiFoxApp /><IssuePeek /></>}<DialogHost /><Toasts /></div>
}
const root = document.getElementById('root')
if (!root) throw Error('Lifecycle fixture root missing')
createRoot(root).render(<Fixture />)
