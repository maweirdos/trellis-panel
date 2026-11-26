import React from 'react'
import { createRoot } from 'react-dom/client'
import { BootstrapGate } from './daemon/BootstrapGate'
import './my/my.css'
import './styles.css'
import { installScrollEdgeFades } from './my/scroll-edge-fade'

installScrollEdgeFades()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root not found')
let appModulePromise: Promise<typeof import('./App')> | undefined
const loadApp = (): Promise<typeof import('./App')> => (appModulePromise ??= import('./App'))
const preloadApp = (): void => {
  void loadApp()
    .then(() => {
      void import('./pages/Chat').catch(() => undefined)
      void import('./conversation-workbench/ConversationWorkbench').catch(() => undefined)
    })
    .catch(() => undefined)
}
const App = React.lazy(loadApp)
const DaemonQuitDialog = React.lazy(() => import('./daemon/QuitDialog').then(m => ({ default: m.DaemonQuitDialog })))
const DaemonLifecycleDialog = React.lazy(() => import('./daemon/LifecycleDialog').then(m => ({ default: m.DaemonLifecycleDialog })))
const mode = new URLSearchParams(window.location.search).get('mode')
const auxiliary = mode === 'doc' || mode === 'capsule' || mode === 'quicktodo'

createRoot(rootEl).render(
  <React.StrictMode>
    {mode === 'daemon-lifecycle' ? <React.Suspense fallback={null}><DaemonLifecycleDialog /></React.Suspense> : mode === 'daemon-quit' ? <React.Suspense fallback={null}><DaemonQuitDialog /></React.Suspense> : auxiliary ? <React.Suspense fallback={null}><App /></React.Suspense> : <BootstrapGate preloadApp={preloadApp}><App /></BootstrapGate>}
  </React.StrictMode>
)
