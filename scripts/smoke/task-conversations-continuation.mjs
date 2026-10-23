/** Production packet/continue/preview/inspect with isolated native fixtures and clipboard. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createFixture, database } from './fixtures/task-conversations-data.mjs'

const directory = mkdtempSync(join(tmpdir(), 'trellis-task-continuation-'))
let service, checks = 0
const check = (value, message) => { assert.ok(value, message); checks++ }
const rejected = async (fn, code) => { await assert.rejects(fn, error => error.code === code); checks++ }
const jsonl = values => values.map(value => JSON.stringify(value)).join('\n') + '\n'
try {
  const bundle = join(directory, 'service.cjs')
  await build({ entryPoints: ['src/main/services/task-conversations/index.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const { TaskConversationsService: Service } = createRequire(import.meta.url)(bundle)
  const f = createFixture(join(directory, 'fixture')), copies = []
  let copyFailure = false, copyHook
  const options = { ...f.options, clipboard: { writeText(text) { if (copyFailure) throw Error('clipboard denied'); copies.push(text); copyHook?.() } } }
  service = new Service(options)
  const candidates = await service.discover(f.root), codex = candidates.items.find(item => item.sessionId === f.codexId)
  let snapshot = await service.bind(f.root, 'task-a', codex.id)
  snapshot = await service.bind(f.root, 'task-b', codex.id)
  const a = snapshot.bindings.find(item => item.taskDir === 'task-a'), b = snapshot.bindings.find(item => item.taskDir === 'task-b')
  f.runtimeRecord(`codex_${f.codexId}.json`, { platform: 'codex', current_task: '.trellis/tasks/task-a' })
  const pointer = join(f.runtime, `codex_${f.codexId}.json`), beforePointer = readFileSync(pointer, 'utf8')
  const taskB = join(f.root, '.trellis', 'tasks', 'task-b', 'task.json')
  writeFileSync(taskB, JSON.stringify({ id: 'stable-task-b', title: 'R1 selected fresh task B', status: 'review', subtasks: ['[ ] actual unfinished'] }))
  writeFileSync(join(f.root, '.trellis', 'tasks', 'task-b', 'prd.md'), '# 待确认\n- [ ] Checkbox question\n- Plain bullet question\n')
  let packet = await service.prepare(f.root, 'task-b')
  check(packet.taskTitle === 'R1 selected fresh task B' && packet.status === 'review', 'packet rebuilds fresh title and actual state')
  check(packet.text.includes('.trellis/tasks/task-b') && !packet.text.includes('.trellis/tasks/task-a'), 'shared parent does not select its active task pointer')
  check(packet.text.includes('下一合法步骤') && packet.text.includes('不是实施批准') && packet.text.includes('安全绑定'), 'continuation preserves workflow barriers and safe binding')
  check(packet.text.includes('Checkbox question') && packet.text.includes('Plain bullet question'), 'handoff handles both question bullet forms')
  check(packet.text.includes('未扫描 Git') && packet.text.length <= 32768 && copies.length === 0, 'prepare is bounded, omits repository scanning and does not copy')
  let continued = await service.continue(f.root, 'task-b', b.id)
  check(continued.copied && continued.opened.sessionId === f.codexId && copies.at(-1) === continued.packet.text, 'continue copies selected task then opens exact bound parent')
  check(f.calls.pop().url === `codex://threads/${f.codexId}`, 'native destination remains exact stored session')
  check(readFileSync(pointer, 'utf8') === beforePointer && JSON.parse(readFileSync(taskB)).status === 'review', 'continuation never writes runtime pointer or lifecycle')
  const copyCount = copies.length
  await rejected(() => service.continue(f.root, 'task-b', a.id), 'E_NOT_FOUND')
  check(copies.length === copyCount && !f.calls.length, 'foreign task binding is rejected before clipboard or launch')
  await rejected(() => service.continue(f.root, 'task-b', b.id, () => false), 'E_CONFLICT')
  check(copies.length === copyCount && !f.calls.length, 'owner generation fence cancels clipboard and launch')
  copyFailure = true; await rejected(() => service.continue(f.root, 'task-b', b.id), 'E_UNAVAILABLE'); copyFailure = false
  check(!f.calls.length, 'clipboard failure never launches')
  f.capabilities.set('codex', { available: false, detail: 'native route unavailable' })
  continued = await service.continue(f.root, 'task-b', b.id)
  check(continued.copied && !!continued.openError && !continued.opened && !f.calls.length, 'copy succeeds while launch unavailable returns truthful partial result')
  f.capabilities.delete('codex')
  let current = true
  copyHook = () => { current = false }
  continued = await service.continue(f.root, 'task-b', b.id, () => current)
  check(continued.copied && !!continued.openError && !f.calls.length, 'generation is checked again after clipboard and before launch')
  copyHook = undefined
  continued = await service.continue(f.root, 'task-b')
  check(continued.copied && !continued.opened && !continued.openError && !f.calls.length, 'explicit copy-only continuation never creates a native session or relationship')
  const originalLaunch = f.launch.launch
  f.launch.launch = async () => { throw Error('native dispatch failed') }
  continued = await service.continue(f.root, 'task-b', b.id)
  check(continued.copied && continued.openError === 'native dispatch failed' && !continued.opened, 'failed native dispatch after copy preserves the copy result')
  f.launch.launch = originalLaunch
  const archived = f.task('archive/2026-10/done-task', 'done-task')
  writeFileSync(join(archived, 'task.json'), JSON.stringify({ id: 'done-task', status: 'completed', title: 'Completed task' }))
  packet = await service.prepare(f.root, 'archive/2026-10/done-task')
  check(packet.mode === 'history' && packet.text.includes('不重新执行') && !packet.text.includes('确认并绑定任务。'), 'completed archived packet is history-only')
  f.task('active-completed', 'active-completed')
  writeFileSync(join(f.root, '.trellis', 'tasks', 'active-completed', 'task.json'), JSON.stringify({ id: 'active-completed', status: 'completed' }))
  check((await service.prepare(f.root, 'active-completed')).mode === 'history', 'completed active directory is also history-only')
  writeFileSync(join(f.root, '.trellis', 'tasks', 'task-b', 'prd.md'), '# 待确认\n' + 'long PRD '.repeat(12000))
  packet = await service.prepare(f.root, 'task-b')
  check(packet.issues.some(issue => issue.includes('64 KiB')) && !packet.text.includes('long PRD'), 'oversized PRD is not loaded into packet')
  f.task('copy-b', 'stable-task-b'); await rejected(() => service.prepare(f.root, 'task-b'), 'E_CONFLICT')
  renameSync(join(f.root, '.trellis', 'tasks', 'copy-b'), join(f.base, 'removed-copy-b'))
  const pending = service.prepare(f.root, 'task-b')
  queueMicrotask(() => writeFileSync(taskB, JSON.stringify({ id: 'stable-task-b', title: 'changed during build', status: 'review' })))
  await rejected(() => pending, 'E_CONFLICT')
  f.task('too-large', 'too-large'); writeFileSync(join(f.root, '.trellis', 'tasks', 'too-large', 'task.json'), JSON.stringify({ id: 'too-large', padding: 'x'.repeat(270000) }))
  await rejected(() => service.prepare(f.root, 'too-large'), 'E_UNAVAILABLE')
  const log = join(f.roots.codex, 'real-rollout-path.jsonl')
  const head = { type: 'session_meta', payload: { id: f.codexId, cwd: f.root } }
  const message = (role, text, channel) => ({ type: 'response_item', payload: { type: 'message', role, channel, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } })
  database(f.codexFile, 'ALTER TABLE threads ADD COLUMN rollout_path TEXT', db => db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(log, f.codexId))
  writeFileSync(log, jsonl([head, message('assistant', 'PRIVATE ANALYSIS', 'analysis'), message('system', 'SYSTEM INSTRUCTION'), message('developer', 'DEVELOPER INSTRUCTION'),
    { type: 'event_msg', payload: { type: 'agent_message', message: 'RAW DUPLICATE' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'TOOL RESULT' } },
    message('user', 'Visible user'), message('assistant', 'Visible commentary', 'commentary'), message('assistant', 'Visible final', 'final')]))
  let preview = await service.preview(f.root, 'task-b', codex.id)
  check(preview.messages.map(item => item.text).join('|') === 'Visible user|Visible commentary|Visible final', 'Codex preview excludes analysis/system/developer/tools/raw duplicates')
  const counts = (await service.list(f.root)).bindings.length
  await service.inspect(f.root, 'task-b', codex.id)
  check(f.calls.pop().url === `codex://threads/${f.codexId}` && (await service.list(f.root)).bindings.length === counts, 'inspect opens existing candidate without saving a relationship')
  await rejected(() => service.inspect(f.root, 'task-b', codex.id, () => false), 'E_CONFLICT')
  check(!f.calls.length, 'inspect honors final launch owner fence')
  f.setOnCapability(async source => { if (source === 'codex') writeFileSync(taskB, JSON.stringify({ id: 'stable-task-b', title: 'replaced during native lookup', status: 'review' })) })
  await rejected(() => service.inspect(f.root, 'task-b', codex.id), 'E_CONFLICT')
  f.setOnCapability(undefined)
  check(!f.calls.length, 'task facts are revalidated after native lookup before independent inspection opens')
  await rejected(() => service.preview(f.root, 'task-b', codex.id, () => false), 'E_CONFLICT')
  writeFileSync(log, jsonl([head, message('assistant', 'hidden middle', 'analysis')]) + 'x'.repeat(700000) + '\n' + jsonl(Array.from({ length: 20 }, (_, index) => message(index % 2 ? 'assistant' : 'user', `Visible ${index} ` + 'a'.repeat(5000)))))
  preview = await service.preview(f.root, 'task-b', codex.id)
  check(preview.truncated && preview.messages.length === 12 && preview.messages.every(item => item.text.length <= 4096), 'huge tail skips partial first record and enforces message/count limits')
  check(preview.messages[0].text.startsWith('Visible 8') && !preview.messages.some(item => item.text.includes('hidden')), 'bounded tail selects only last visible messages with head identity proof')
  appendFileSync(log, jsonl([{ ...message('user', 'FOREIGN TEXT'), sessionId: randomUUID() }]))
  preview = await service.preview(f.root, 'task-b', codex.id)
  check(preview.unavailableReason && !preview.messages.length, 'a mismatched identity record rejects the tail')
  writeFileSync(log, jsonl([{ type: 'session_meta', payload: { id: f.codexId, cwd: f.foreign } }, message('user', 'FOREIGN PROJECT')]))
  check((await service.preview(f.root, 'task-b', codex.id)).unavailableReason, 'wrong root metadata is unavailable')
  database(f.codexFile, 'ALTER TABLE threads RENAME TO unavailable_threads')
  preview = await service.preview(f.root, 'task-b', codex.id)
  check(!!preview.unavailableReason && !preview.messages.length, 'unavailable native source returns a plain unavailable preview')
  database(f.codexFile, 'ALTER TABLE unavailable_threads RENAME TO threads')
  database(f.codexFile, null, db => db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(f.claudeFile, f.codexId))
  check(!(await service.preview(f.root, 'task-b', codex.id)).messages.length, 'descriptor containment prevents reading another native source')
  const claude = candidates.items.find(item => item.sessionId === f.claudeId)
  const c = (type, content, extra = {}) => ({ type, sessionId: f.claudeId, cwd: f.root, message: { role: type, content }, ...extra })
  writeFileSync(f.claudeFile, jsonl([c('user', 'Claude visible user'), c('assistant', [{ type: 'thinking', thinking: 'PRIVATE THINKING' }, { type: 'text', text: 'Claude visible answer' }]), c('user', [{ type: 'tool_result', content: 'PRIVATE TOOL' }])]))
  preview = await service.preview(f.root, 'task-b', claude.id)
  check(preview.messages.map(item => item.text).join('|') === 'Claude visible user|Claude visible answer', 'Claude exposes only text beside thinking and omits user tool results')
  appendFileSync(f.claudeFile, jsonl([c('assistant', [{ type: 'text', text: 'SIDECHAIN' }], { isSidechain: true })]))
  check((await service.preview(f.root, 'task-b', claude.id)).unavailableReason, 'Claude sidechain is unavailable')
  const z = candidates.items.find(item => item.sessionId === f.zcodeId), workspaceKey = 'preview-workspace'
  database(f.zcodeFile, 'ALTER TABLE tasks ADD COLUMN workspace_key TEXT', db => db.prepare('UPDATE tasks SET workspace_key=? WHERE task_id=?').run(workspaceKey, f.zcodeId))
  const zfile = join(f.roots.zcode, 'sessions', workspaceKey, `${f.zcodeId}.json`)
  mkdirSync(join(f.roots.zcode, 'sessions', workspaceKey), { recursive: true })
  const snapshotJson = { meta: { taskId: f.zcodeId, workspacePath: f.root, acpSessionId: 'not-the-native-id' }, messages: [
    { role: 'user', content: 'ZCode visible' }, { role: 'assistant', channel: 'analysis', content: 'PRIVATE Z REASONING' }, { role: 'assistant', content: [{ type: 'thinking', text: 'PRIVATE Z THINKING' }, { type: 'text', text: 'ZCode answer' }], tools: [{ output: 'PRIVATE Z TOOL' }] }
  ] }
  writeFileSync(zfile, JSON.stringify(snapshotJson))
  preview = await service.preview(f.root, 'task-b', z.id)
  check(preview.messages.map(item => item.text).join('|') === 'ZCode visible|ZCode answer', 'ZCode validates native snapshot and filters hidden/tool text')
  snapshotJson.messages.push({ role: 'user', content: 'x'.repeat(2200000) }); writeFileSync(zfile, JSON.stringify(snapshotJson))
  check((await service.preview(f.root, 'task-b', z.id)).unavailableReason.includes('2 MiB'), 'oversized ZCode snapshot is explicitly unavailable')
  check(!('historyFiles' in preview) && !('file' in preview), 'no native paths/descriptors are projected through preview IPC')
  console.log(JSON.stringify({ ok: true, checks, scope: 'selected-task packets, clipboard/launch fences, visible preview and inspection; isolated native files, no client activation' }))
} finally { service?.close(); rmSync(directory, { recursive: true, force: true }) }
