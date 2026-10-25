import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HiFoxApp } from '../../../src/renderer/src/hifox/HiFoxApp'
import { COLLABORATION_MODULES } from '../../../src/renderer/src/hifox/navigation'
import { useHifox } from '../../../src/renderer/src/hifox/store'
import { useMy } from '../../../src/renderer/src/my/store'
import { useApp } from '../../../src/renderer/src/store'
import { IssuePeek } from '../../../src/renderer/src/my/pages/IssuePeek'
import type { ProjectSnapshot } from '../../../src/shared/types'
import type { HifoxWorkspaceContext } from '../../../src/shared/hifox-remote'
import { DialogHost } from '../../../src/renderer/src/components/Dialogs'
import { Toasts } from '../../../src/renderer/src/components/Toasts'
import { dispatchEscKey } from '../../../src/renderer/src/utils/esc-layer'
import type { HifoxModule } from '../../../src/renderer/src/hifox/store'
import type { UiFontSize } from '../../../src/renderer/src/my/appearance'
import type { Priority } from '../../../src/renderer/src/my/types'
import { LayoutIcon, NavIcon, PriorityIcon } from '../../../src/renderer/src/my/icons'
import { Button, Dropdown, DropdownItem, Modal } from '../../../src/renderer/src/my/ui'
import { InteractionScope } from '../../../src/renderer/src/utils/interaction-scope'

let showFocusProbe: ((visible: boolean) => void) | undefined

const fixture = {
  // The compatibility board route is presented by the native task layout selector.
  modules: COLLABORATION_MODULES.filter((entry) => entry.id !== 'board'),
  state: () => useHifox.getState(),
  bootstrap: () => useHifox.getState().bootstrap(),
  setModule: (module: HifoxModule) => useHifox.getState().setModule(module),
  setSpace: (id: string) => useHifox.getState().setCurrentSpace(id),
  createTask: () => useHifox.getState().setCreateTaskOpen(true),
  openTask: (id: string | null) => useHifox.getState().openTask(id),
  context: (context: HifoxWorkspaceContext) => useHifox.setState({ workspaceContext: context }),
  refreshNative: () => useApp.getState().refresh(),
  nativeSnapshot: (snapshot: ProjectSnapshot) => { useApp.setState({ snapshot, page: 'hifox' }); useMy.getState().syncFromSnapshot() },
  nativeState: () => { const state = useApp.getState(); return { page: state.page, root: state.snapshot?.meta.root, tasks: state.snapshot?.tasks.map((task) => task.dirName), openTaskDir: state.openTaskDir, taskExpandOrigin: state.taskExpandOrigin } },
  nativeIssue: (id: string) => useMy.getState().openIssue(id),
  appearance: (theme: 'light' | 'dark', fontSize: UiFontSize) => useMy.setState({ theme, fontSize }),
  sidebar: (collapsed: boolean) => useMy.setState({ sidebarCollapsed: collapsed }),
  focusProbe: (visible: boolean) => { if (!showFocusProbe) throw Error('Focus fixture not mounted'); showFocusProbe(visible) }
}
declare global { interface Window { hifoxFixture: typeof fixture } }
window.hifoxFixture = fixture
useApp.getState().setPage('hifox')

function Fixture(): JSX.Element {
  const theme = useMy((state) => state.theme)
  const fontSize = useMy((state) => state.fontSize)
  const [focusProbe, setFocusProbe] = useState(false)
  useEffect(() => { showFocusProbe = setFocusProbe; return () => { showFocusProbe = undefined } }, [])
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => { if (event.key === 'Escape' && dispatchEscKey()) { event.preventDefault(); event.stopPropagation() } }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])
  return <div className="my-root hifox-fixture-root" data-my-theme={theme} data-my-font-size={fontSize}>{focusProbe ? <DropdownFocusProbe /> : <HiFoxApp />}<IssuePeek /><DialogHost /><Toasts /></div>
}

function DropdownFocusProbe(): JSX.Element {
  const outside = useRef<HTMLInputElement>(null)
  const [active, setActive] = useState(true)
  const [hidden, setHidden] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [modal, setModal] = useState(false)
  return <div data-focus-regression className="flex flex-col items-start gap-4 p-5">
    <Button onClick={() => { setActive(true); setHidden(false); setGeneration((current) => current + 1) }}>Reset probe</Button>
    <input ref={outside} aria-label="Outside focus target" className="my-input" />
    <InteractionScope key={generation} active={active}>
      <div hidden={hidden}>
        <Dropdown width={230} trigger={({ toggle }) => <Button aria-label="Focus probe menu" onClick={toggle}>Focus probe menu</Button>}>
          {(close) => <>
            <DropdownItem onClick={close}>Select and close</DropdownItem>
            <DropdownItem onClick={() => { outside.current?.focus(); close() }}>Focus another control</DropdownItem>
            <DropdownItem onClick={() => { setModal(true); close() }}>Open a modal</DropdownItem>
            <DropdownItem onClick={() => { close(); setHidden(true) }}>Hide the trigger</DropdownItem>
            <DropdownItem onClick={() => { close(); setActive(false) }}>Suspend the source</DropdownItem>
            <DropdownItem onClick={() => { close(); setGeneration((current) => current + 1) }}>Replace the source</DropdownItem>
          </>}
        </Dropdown>
      </div>
    </InteractionScope>
    <div className="flex gap-3">{(['urgent', 'high', 'medium', 'low', 'none'] as Priority[]).map((priority) => <span key={priority} data-focus-priority={priority}><PriorityIcon priority={priority} className="text-my-icon-tertiary" /></span>)}</div>
    <div data-focus-neutral className="flex gap-3 text-my-icon-secondary"><NavIcon name="views" /><LayoutIcon layout="board" /></div>
    <Modal open={modal} onClose={() => setModal(false)} ariaLabel="Focus probe dialog"><div className="p-5"><input autoFocus aria-label="Modal focus target" className="my-input" /><Button onClick={() => setModal(false)}>Close probe dialog</Button></div></Modal>
  </div>
}
const root = document.getElementById('root')
if (!root) throw Error('HiFox fixture root missing')
createRoot(root).render(<Fixture />)
