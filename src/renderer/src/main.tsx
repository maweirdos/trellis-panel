import React from 'react'
import { createRoot } from 'react-dom/client'
import { DaemonQuitDialog } from './daemon/QuitDialog'
import { BootstrapGate } from './daemon/BootstrapGate'
import './my/my.css'
import './styles.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root not found')
const App = React.lazy(() => import('./App'))
const mode = new URLSearchParams(window.location.search).get('mode')
const auxiliary = mode === 'doc' || mode === 'capsule' || mode === 'quicktodo'

createRoot(rootEl).render(
  <React.StrictMode>
    {mode === 'daemon-quit' ? <DaemonQuitDialog /> : auxiliary ? <React.Suspense fallback={null}><App /></React.Suspense> : <BootstrapGate><App /></BootstrapGate>}
  </React.StrictMode>
)
