import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PrototypePreview } from '../../../src/renderer/src/creations/PrototypePreview'

window.previewEvents = []

function Fixture() {
  const [config, set] = useState({
    body: '<main><button id="save" onclick="this.textContent=\'Saved\'">Save</button></main>',
    mode: 'browse', theme: 'light', font: 'standard', selectedTarget: null, markers: []
  })
  window.previewFixture = { set, config }
  return (
    <div id="fixture" className="my-root" data-my-theme={config.theme} data-my-font-size={config.font} style={{
      height: '100%', background: 'var(--my-bg-canvas)', fontSize: 'var(--my-text-ui)', fontFamily: 'var(--my-font-sans)'
    }}>
      <PrototypePreview
        {...config}
        minHeight={120}
        onSelect={(target) => window.previewEvents.push({ type: 'selection', target })}
        onAnchorStatus={(status) => window.previewEvents.push({ type: 'status', status })}
        onMarkerClick={(id) => window.previewEvents.push({ type: 'marker', id })}
        onExitAnnotate={() => window.previewEvents.push({ type: 'exit' })}
        onInteraction={(event) => window.previewEvents.push({ type: 'interaction', event })}
      />
    </div>
  )
}

createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture /></React.StrictMode>)
