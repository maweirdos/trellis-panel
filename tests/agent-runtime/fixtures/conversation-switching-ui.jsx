import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AcpConsolePage } from '../../../src/renderer/src/acp/ConsoleWorkspace.tsx'
import { InteractionScope } from '../../../src/renderer/src/utils/interaction-scope.tsx'
import { useApp } from '../../../src/renderer/src/store/index.ts'
import { readSessionView, writeSessionView } from '../../../src/renderer/src/acp/view-state.ts'
import { rebindSubmittedReferences } from '../../../src/renderer/src/acp/conversation-switching.ts'

const invoke = (name, ...args) => window.switchingBridge.invoke(name, args)
const on = name => callback => window.switchingBridge.on(name, callback)
window.fixtureApi = {
  acpAgents: async () => ({ ok: true, agents: [{ id: 'codex', runtimeId: 'codex', name: 'Codex', enabled: true, available: true }] }),
  acpProfiles: async () => ({ ok: true, profiles: [{ id: 'fixture-role', name: 'Fixture role', runtimeId: 'codex', instructions: '', maxTurnMinutes: 30 }] }),
  acpHistoryList: (...args) => invoke('list', ...args),
  acpHistorySession: (...args) => invoke('session', ...args),
  acpHistoryEvents: (...args) => invoke('events', ...args),
  acpSessionResume: (...args) => invoke('resume', ...args),
  acpSessionPrompt: (...args) => invoke('prompt', ...args),
  acpSessionCancel: (...args) => invoke('cancel', ...args),
  acpSessionKill: (...args) => invoke('kill', ...args),
  acpSessionNew: (...args) => invoke('new', ...args),
  acpSessions: (...args) => invoke('legacy-list', ...args),
  onAcpOutput: on('output'), onAcpState: on('state'), onAcpDone: on('done'),
  onMaterialUpdated: () => () => {}
}
const field = () => document.querySelector('[aria-label="Agent 指令"]')
window.fixture = {
  select: id => document.querySelector(`[data-acp-session="${id}"]`).click(),
  draft: text => {
    const node = field()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, text)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  },
  submit: () => document.querySelector('[title="发送指令"]')?.click(),
  enter: () => field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })),
  image: name => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF04AAAAASUVORK5CYII='), c => c.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], name, { type: 'image/png' }))
    field().dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }))
  },
  seed: (id, state) => writeSessionView(useApp.getState().snapshot.meta.root, id, state),
  saved: id => readSessionView(useApp.getState().snapshot.meta.root, id),
  referenceCases: () => {
    const original = { sessionId: 'ref', projectRoot: 'D:/project', taskDir: 'task', backendSessionId: 'native-ref', agentSessionId: 'agent-ref', connectionGeneration: 'old' }
    const fresh = { ...original, connectionGeneration: 'new' }
    const source = { projectRoot: original.projectRoot, taskDir: original.taskDir, relativePath: '.trellis/tasks/task/prd.md', displayedRevision: 'exact-revision', targetSessionId: original.sessionId, targetConnectionGeneration: 'old', quote: 'Captured words' }
    const submitted = [source]
    const rebound = rebindSubmittedReferences(original, fresh, submitted)
    const rejected = [
      [{ backendSessionId: undefined }, {}], [{ backendSessionId: '' }, {}], [{}, { backendSessionId: undefined }],
      [{}, { backendSessionId: 'other' }], [{}, { agentSessionId: undefined }], [{}, { agentSessionId: 'other' }],
      [{}, { projectRoot: 'D:/other' }], [{}, { taskDir: 'other' }], [{}, { sessionId: 'other' }]
    ].map(([oldPatch, newPatch]) => { try { rebindSubmittedReferences({ ...original, ...oldPatch }, { ...fresh, ...newPatch }, submitted); return false } catch { return true } })
    return { rebound, original: submitted, rejected,
      optionalAgent: rebindSubmittedReferences({ ...original, agentSessionId: undefined }, { ...fresh, agentSessionId: undefined }, submitted) }
  },
  snapshot: () => ({
    title: document.querySelector('.acp-header-identity')?.textContent,
    header: document.querySelector('.acp-session-status')?.textContent,
    draft: field()?.value,
    transcript: document.querySelector('.acp-transcript')?.textContent,
    allImages: [...document.querySelectorAll('.acp-composer img')].map(e => e.alt),
    references: document.querySelector('.acp-source-references')?.textContent,
    historyError: document.querySelector('.acp-history-note[role="alert"]')?.textContent,
    connection: document.querySelector('[aria-label="当前连接与保存状态"]')?.textContent,
    sendDisabled: document.querySelector('[title="发送指令"]')?.disabled ?? true,
    currentPhase: document.querySelector('[aria-label="当前回合状态"]')?.dataset.phase,
    overflow: document.documentElement.scrollWidth > innerWidth
  })
}
function Fixture() {
  const [settings, setSettings] = useState(false)
  const [theme, setTheme] = useState('light')
  window.fixture.settings = setSettings
  window.fixture.theme = setTheme
  window.fixture.root = root => useApp.setState({ snapshot: { meta: { root }, tasks: [] } })
  return <div className="my-root text-my-md text-my-primary" data-my-theme={theme} data-my-font-size="standard">
    <div hidden={settings} aria-hidden={settings || undefined} ref={node => { if (node) node.inert = settings }} style={{ height: '100%' }}>
      <InteractionScope active={!settings}><AcpConsolePage /></InteractionScope>
    </div>
    {settings && <input id="settings-focus" aria-label="Settings fixture" />}
  </div>
}
createRoot(document.getElementById('root')).render(<Fixture />)
