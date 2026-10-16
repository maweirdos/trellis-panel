/** Real task UI/session/reader transitions; mounted reader lifetime still requires a UI walkthrough. */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-task-presentation-'))
const absolute = (path) => resolve(path).replace(/\\/g, '/')
globalThis.localStorage = { getItem: () => null, setItem() {} }
globalThis.window = { location: { search: '?my=1' }, trellis: {} }

try {
  const entry = join(temporary, 'entry.ts')
  const bundle = join(temporary, 'bundle.mjs')
  writeFileSync(entry, [
    `export { useApp } from '${absolute('src/renderer/src/store/index.ts')}'`,
    `export * from '${absolute('src/renderer/src/reader/task-materials.ts')}'`,
    `export { readingSessionKey } from '${absolute('src/renderer/src/reader/reading-session.ts')}'`
  ].join('\n'))
  execFileSync(process.execPath, [
    join('node_modules', 'esbuild', 'bin', 'esbuild'), entry, '--bundle', '--platform=node', '--format=esm',
    '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    `--outfile=${bundle}`
  ], { stdio: 'inherit' })
  const { useApp, readingSessionKey, taskMaterialGroup, TASK_MATERIAL_GROUPS } = await import(pathToFileURL(bundle).href)
  const state = () => useApp.getState()
  const root = 'D:/project-a'
  useApp.setState({ snapshot: { meta: { root } }, page: 'team' })
  state().showTask('task-a')
  const origin = { fromPage: 'team', taskDir: 'task-a', archived: false, scrollTop: 382 }
  const key = readingSessionKey({ workspaceId: root, taskRef: 'task-a' }, '.trellis/tasks/task-a/prd.md')
  state().readerOpenSession(key, { revision: 'base-v1', text: '旧版需求' })
  state().readerExternalChange(key, { revision: 'pending-v2', text: '未确认的新版本' })
  const before = state().readingSessions[key]
  state().expandTaskWorkspace(origin)
  assert.equal(state().page, 'team', 'expansion keeps the source route mounted')
  assert.deepEqual(state().taskExpandOrigin, origin)
  assert.equal(state().readingSessions[key], before, 'expansion does not rebase or read a pending version')
  assert.equal(state().taskMaterialTarget, null)
  assert.deepEqual(state().returnFromWorkspace(), origin)
  assert.equal(state().openTaskDir, 'task-a')
  assert.equal(state().readingSessions[key], before)
  assert.equal(state().readingSessions[key].displayed.revision, 'base-v1')
  assert.equal(state().readingSessions[key].latest.revision, 'pending-v2')

  state().expandTaskWorkspace(origin, 'D:/project-a/.trellis/tasks/task-a/design.md')
  assert.match(state().taskMaterialTarget, /design\.md$/)
  state().setTaskMaterialTarget(null)
  state().showTask('task-b', true)
  const current = state().returnFromWorkspace()
  assert.equal(current.taskDir, 'task-b', 'return preserves selection changed while expanded')
  assert.equal(current.archived, true)
  assert.equal(current.scrollTop, 382)
  assert.equal(state().returnFromWorkspace(), null)
  assert.equal(state().openTaskDir, 'task-b', 'a repeated return is harmless')

  state().expandTaskWorkspace(origin)
  state().showTask(null, true)
  assert.equal(state().taskExpandOrigin, null)
  assert.equal(state().taskMaterialTarget, null)
  assert.equal(state().openTaskArchived, false)
  state().expandTaskWorkspace(origin, '/old-material')
  state().setPage('knowledge')
  assert.equal(state().taskExpandOrigin, null)
  assert.equal(state().openTaskDir, null)
  assert.equal(state().taskMaterialTarget, null)

  state().expandTaskWorkspace(origin)
  state().openSpecDocument('D:/project-a/.trellis/spec/frontend/index.md')
  assert.equal(state().page, 'spec')
  assert.equal(state().openTaskDir, null)
  assert.equal(state().taskExpandOrigin, null)
  assert.equal(state().consumeSpecDocumentTarget().projectRoot, root)
  assert.equal(state().consumeSpecDocumentTarget(), null, 'spec targeting is one-shot')
  state().openSpecDocument('/another')
  state().setPage('dashboard')
  assert.equal(state().specDocumentTarget, null)
  useApp.setState({ snapshot: null })
  state().openSpecDocument('/unbound')
  assert.equal(state().specDocumentTarget, null)
  assert.equal(state().page, 'dashboard', 'an unbound target cannot open a project document')

  assert.equal(TASK_MATERIAL_GROUPS[0].id, 'all')
  for (const [file, group] of [
    ['PRD.md', 'requirements'], ['research/notes.md', 'requirements'], ['design.md', 'execution'],
    ['implement.md', 'execution'], ['check.md', 'validation'], ['验收记录.md', 'validation'],
    ['implement.jsonl', 'execution'], ['context/IMPLEMENT.JSONL', 'execution'],
    ['check.jsonl', 'validation'], ['context\\CHECK.JSONL', 'validation'],
    ['task.json', 'other'], ['research/events.jsonl', 'other'], ['unknown.weird', 'other']
  ]) assert.equal(taskMaterialGroup(file), group, file)
  console.log('PASS task presentation: source route, pending reader state, selection/return, close/navigation, one-shot targets and material fallback')
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(temporary.includes('tpanel-task-presentation-'))
  rmSync(temporary, { recursive: true, force: true })
}
