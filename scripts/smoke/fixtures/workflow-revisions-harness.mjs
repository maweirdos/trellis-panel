/** Owned native transport fixture; production application/control/material/driver remain actual. */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
export const pause = (ms) => new Promise((done) => setTimeout(done, ms))
export async function until(fn, label, timeout = 8000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await fn(); if (result) return result; await pause(15) } throw Error('Timeout: ' + label) }
const hash = (text) => createHash('sha256').update(text).digest('hex')
const asset = (id) => ({ assetId: id, version: hash(id), digest: hash(id) })
export const agent = (id) => ({ id, name: id, kind: 'agent', instruction: `RUN_STAGE:${id}` })
export function createFixturePort(root, options = {}) {
  const sessions = new Map([['origin', { sessionId: 'origin', projectRoot: root, taskDir: 'task-a', agentId: 'fixture', agentName: 'Fixture', status: 'ready', startedAt: Date.now(), connectionGeneration: 'origin-generation' }]])
  const observers = new Set(); const history = []; const prompts = []; const releases = new Map()
  let sequence = 0; let creates = 0; let ends = 0; let endFails = options.endFails ?? false; let resolveCreate; let resolveEnd
  const creation = new Promise((done) => { resolveCreate = done })
  const ending = new Promise((done) => { resolveEnd = done })
  const emit = (session, result) => {
    const event = { id: randomUUID(), ts: Date.now(), source: 'acp', kind: 'turn-done', projectRoot: root, taskDir: session.taskDir, sessionId: session.sessionId, turnId: session.turnId, connectionGeneration: session.connectionGeneration, payload: { result } }
    history.push({ ...event, historySeq: ++sequence }); for (const observer of observers) observer.event?.(event)
  }
  const port = {
    create: async (_root, input) => {
      creates++; if (options.deferredCreate) await creation
      const id = `stage-${creates}`; sessions.set(id, { sessionId: id, projectRoot: root, taskDir: input.taskDir, agentId: input.agentId, agentName: 'Fixture', status: 'ready', startedAt: Date.now(), connectionGeneration: `generation-${creates}` }); return { ok: true, sessionId: id }
    },
    get: async (_root, id) => sessions.has(id) ? { ok: true, session: structuredClone(sessions.get(id)) } : { ok: false, code: 'E_NOT_FOUND', error: 'Owned fixture session missing' },
    list: () => ({ ok: true, sessions: [...sessions.values()] }),
    prompt: async (_root, id, instruction, _input, prepared) => {
      const session = sessions.get(id); prepared.assertActive(); session.status = 'busy'; session.turnId = `turn-${prompts.length + 1}`
      const step = /RUN_STAGE:([\w-]+)/.exec(instruction)?.[1]; const index = prompts.length
      prompts.push({ step, instruction, packet: prepared.materials.text, sessionId: id, turnId: session.turnId })
      const identity = { sessionId: id, turnId: session.turnId, connectionGeneration: session.connectionGeneration }
      prepared.onAdmitted?.(identity); prepared.onPromptWritten?.(identity)
      void (async () => {
        if (options.blocked && index === 0) await new Promise((done) => releases.set(id, done))
        await pause(15)
        if (session.status === 'closed') return
        const body = options.body ? options.body(step, prompts.filter((prompt) => prompt.step === step).length) : `# ${step}\nACTUAL_OUTPUT_${step}\n`
        writeFileSync(join(root, '.trellis/tasks/task-a', `${step}.md`), body)
        if (options.providerFailure) { session.status = 'ready'; emit(session, { status: 'failed', error: { message: 'Fixture response missing after owned file side effect' } }); return }
        session.status = 'ready'; emit(session, { status: 'completed', stopReason: 'end_turn' })
      })().catch((error) => { session.status = 'error'; session.error = error.message })
      return { ok: true, turnId: session.turnId }
    },
    cancel: async () => ({ ok: true }),
    end: async (_root, id) => { ends++; if (options.deferredEnd && ends === 1) await ending; if (endFails) return { ok: false, code: 'E_IO', error: 'Owned fixture shutdown unconfirmed' }; const session = sessions.get(id); if (session && session.status !== 'closed') { session.status = 'closed'; releases.get(id)?.(); if (session.turnId) emit(session, { status: 'cancelled', stopReason: 'cancelled' }) } return { ok: true } },
    observe: (observer) => { observers.add(observer); return () => observers.delete(observer) },
    resume: async (_root, id) => ({ ok: true, sessionId: id }), flushHistory: async () => {},
    persistence: () => ({ state: 'saved', pendingCount: 0, committedThroughSeq: sequence, committedThroughEventId: history.at(-1)?.id ?? null }),
    historyEvents: async () => ({ ok: true, events: history, historyPersistence: port.persistence() })
  }
  return { port, sessions, prompts, history, releases, releaseCreate: resolveCreate, releaseEnd: resolveEnd, get creates() { return creates }, get ends() { return ends }, setEndFailure: (on) => { endFails = on }, release: () => { for (const release of releases.values()) release() },
    async teardown() { endFails = false; resolveCreate(); resolveEnd(); for (const [id] of sessions) if (id !== 'origin') await port.end(root, id); for (const release of releases.values()) release() } }
}
export async function harness(api, directory, options = {}) {
  const root = options.root ?? join(directory, 'workspace-' + randomUUID()); const task = join(root, '.trellis/tasks/task-a')
  mkdirSync(task, { recursive: true }); mkdirSync(join(root, '.trellis/flows'), { recursive: true })
  writeFileSync(join(task, 'task.json'), JSON.stringify({ id: 'task-a', status: 'in_progress' }))
  const flows = { old: options.oldSteps ?? [agent('old'), agent('obsolete')], revised: options.newSteps ?? [agent('revised')] }
  const policies = {}
  for (const [id, steps] of Object.entries(flows)) {
    writeFileSync(join(root, '.trellis/flows', `${id}.flow.json`), JSON.stringify({ version: 1, id, name: id, description: 'Owned revision fixture', inputs: [], phases: [{ id: 'phase', name: 'phase', steps }] }))
    for (const step of steps) if (step.kind === 'agent') policies[step.id] = { output: { contract: asset('output-' + step.id), files: [{ relativePath: `.trellis/tasks/task-a/${step.id}.md`, kind: 'other', required: true }], maxRepairTurns: 0 } }
  }
  const fake = createFixturePort(root, options)
  const executor = { binding: { bindingId: 'fixture-binding', engineId: 'fixture', engineVersion: 'unknown', adapterVersion: 'fixture-1', configuration: asset('fixture-native-defaults'), capabilities: {} }, agentId: 'fixture' }
  const config = { projectRoot: root, acp: fake.port, ...(options.previewTtlMs === undefined ? {} : { previewTtlMs: options.previewTtlMs }), driverTimeouts: { startupTimeoutMs: 2500, turnTimeoutMs: options.turnTimeoutMs ?? 5000 }, resolveDefinition: (input) => api.readLocalApplicationDefinition({ projectRoot: root, flowId: input.flowId, executor, nodes: policies }) }
  const app = await api.WorkflowApplicationService.create(config)
  return { root, task, app, fake, config, flows, policies, async start() { const preview = await app.preview({ taskDir: 'task-a', flowId: 'old', origin: { sessionId: 'origin', connectionGeneration: 'origin-generation' } }); return app.start({ taskDir: 'task-a', commandId: 'start-old', previewId: preview.previewId }) },
    async preview(run, boundary = 'after-current-stage') { return app.previewRevision({ taskDir: 'task-a', run, flowId: 'revised', reason: 'Apply a reviewed local correction', boundary }) },
    async final() { return until(async () => { const value = await app.snapshot({ taskDir: 'task-a' }); return ['verified', 'failed', 'stopped', 'outcome-unknown'].includes(value.snapshot?.run.state) ? value : null }, 'actual controller terminal') },
    async cleanup() { await fake.teardown(); await pause(20); try { await app.close() } catch { await app.control.close() } } }
}
