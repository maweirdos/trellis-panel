import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ProfileSkills } from '../../../src/renderer/src/acp/ProfileSkills.tsx'
import { ProfileEditor } from '../../../src/renderer/src/acp/ProfileEditor.tsx'
import { AgentRoleDetails } from '../../../src/renderer/src/acp/AgentRoleDetails.tsx'
import { SessionDetails } from '../../../src/renderer/src/acp/SessionDetails.tsx'
import { InteractionScope } from '../../../src/renderer/src/utils/interaction-scope.tsx'

const root = 'D:/project'
const profile = { id: 'role', name: '需求助手', description: '需求分析', runtimeId: 'codex', instructions: '保留原始需求。', maxTurnMinutes: 30, skillPaths: [], createdAt: 1, updatedAt: 1 }
const agents = [{ id: 'codex', runtimeId: 'codex', name: 'Codex', enabled: true, available: true, health: 'ready' }]
const revision = 'a'.repeat(64)
const context = { state: 'sent', method: 'embedded-resource', revision, uri: 'trellis-agent-context://fixture', instructionsProvided: true, skills: [{ relativePath: '.agents/skills/review/SKILL.md', name: '需求审阅', description: '检查验收边界', revision }], connectionGeneration: 'generation-1', turnId: 'turn-1' }
const session = { sessionId: 'history', agentId: 'codex', agentName: 'Codex', projectRoot: root, status: 'disconnected', historyKind: 'transcript', startedAt: 1, connectionGeneration: 'generation-1', turnId: 'turn-1', capabilities: { controls: [], promptCapabilities: { embeddedContext: true } }, profileSnapshot: { ...profile, skillPaths: ['.agents/skills/frozen/SKILL.md'] }, agentContext: context, events: [] }

const scans = []
const saves = []
const callbacks = []
let saveError = ''
let scanMode = 'held'
let scanResult = { ok: true, scan: { extensions: [] } }
Object.assign(window.trellis, {
  studioScan: () => {
    const request = { root: window.fixtureState.root, settled: false }
    scans.push(request)
    if (scanMode === 'immediate') return Promise.resolve(scanResult)
    return new Promise((resolve, reject) => { request.resolve = (result) => { request.settled = true; resolve(result) }; request.reject = (message) => { request.settled = true; reject(new Error(message)) } })
  },
  acpProfileSave: async (input) => {
    saves.push(structuredClone(input))
    return saveError ? { ok: false, error: saveError } : { ok: true, profile: { ...input, updatedAt: 2 } }
  }
})

const skill = (path, name = '需求审阅', kind = 'skill') => ({ path, name, kind, frontmatter: { description: '检查验收边界' }, platform: 'codex', platformName: 'Codex', invocation: null, format: 'md', size: 100, mtime: 1 })
const ok = (entries) => ({ ok: true, scan: { extensions: entries } })
window.contextFixture = { scans, saves, callbacks, skill, ok, profile, session, context,
  scanMode: (mode, result = ok([])) => { scanMode = mode; scanResult = result },
  saveError: (message) => { saveError = message }
}

function Fixture() {
  const [config, setConfig] = useState({ mode: 'picker', root, open: true, active: true, current: true, key: 0, value: [], theme: 'light', size: 'standard', section: 'skills' })
  const [value, setValue] = useState([])
  const [savedProfile, setSavedProfile] = useState(profile)
  window.fixtureState = config
  window.configureFixture = (patch) => { if (patch.value) setValue(patch.value); if (patch.profile) setSavedProfile(patch.profile); setConfig((previous) => ({ ...previous, ...patch })) }
  window.selection = value
  const isCurrent = () => window.fixtureState.current
  const common = { agents, root: config.root, isCurrent }
  const historic = { ...session, ...config.session }
  const updated = (result) => { callbacks.push(result); setSavedProfile(result) }
  return <div className="my-root font-sans text-my-primary" data-my-theme={config.theme} data-my-font-size={config.size}>
    <main className="acp-inspector-body" style={{ maxWidth: 620, margin: '0 auto' }}>
      <InteractionScope active={config.active}>
        {config.open && <React.Fragment key={config.key}>
          {config.mode === 'picker' && <ProfileSkills {...common} value={value} onChange={setValue} disabled={config.disabled} />}
          {config.mode === 'editor' && <ProfileEditor {...common} inline isNew initial={savedProfile} onSaved={updated} onDeleted={() => {}} onClose={() => setConfig((previous) => ({ ...previous, open: false }))} />}
          {config.mode === 'role' && <AgentRoleDetails {...common} profile={config.historical ? historic.profileSnapshot : savedProfile} currentProfile={config.deleted ? undefined : savedProfile} session={config.historical ? historic : undefined} section={config.section} onSection={(section) => setConfig((previous) => ({ ...previous, section }))} onAgentsChange={() => {}} onUpdated={() => {}} onProfileChange={updated} onNew={() => {}} onContinue={() => {}} onEdit={() => {}} onKnowledge={() => {}} onSpec={() => {}} />}
          {config.mode === 'session' && <SessionDetails detailsOnly session={historic} isCurrent={isCurrent} onUpdated={() => {}} />}
        </React.Fragment>}
      </InteractionScope>
    </main>
  </div>
}
createRoot(document.getElementById('root')).render(<Fixture />)
