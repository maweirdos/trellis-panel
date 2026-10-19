/** Navigation coverage and real shell-store project transitions. No IPC or task writes. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-navigation-'))
const absolute = (path) => resolve(path).replace(/\\/g, '/')
const values = new Map([
  ['tpanel.my.favorites', '["legacy-task"]'],
  ['tpanel.my.views', '[{"id":"legacy-view"}]'],
  ['tpanel.my.ui', JSON.stringify({ layout: 'board', groupBy: 'cycle', favorites: ['embedded-legacy'] })]
])
const storage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value) }
}
globalThis.localStorage = storage
const transport = {}
globalThis.window = { location: { search: '?my=1' }, trellis: transport }

try {
  const entry = join(temporary, 'entry.ts')
  const bundle = join(temporary, 'bundle.mjs')
  writeFileSync(entry, [
    `export * from '${absolute('src/renderer/src/my/navigation.ts')}'`,
    `export * from '${absolute('src/renderer/src/my/project-preferences.ts')}'`,
    `export { useMy } from '${absolute('src/renderer/src/my/store.ts')}'`,
    `export { useApp } from '${absolute('src/renderer/src/store/index.ts')}'`
  ].join('\n'))
  execFileSync(process.execPath, [
    join('node_modules', 'esbuild', 'bin', 'esbuild'), entry,
    '--bundle', '--platform=node', '--format=esm',
    '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    `--outfile=${bundle}`
  ], { stdio: 'inherit' })
  const m = await import(pathToFileURL(bundle).href)

  // Actual appearance store writes remain application-scoped and preserve older UI fields.
  assert.equal(m.useMy.getState().fontSize, 'standard')
  assert.equal(m.useMy.getState().sidebarWidth, 275, 'unset sidebar preference uses the shared baseline')
  m.useMy.getState().setFontSize('small')
  assert.equal(m.useMy.getState().fontSize, 'small', 'an explicit compact preference remains valid')
  m.useMy.getState().setFontSize('large')
  assert.equal(JSON.parse(storage.getItem('tpanel.my.ui')).fontSize, 'large')
  assert.deepEqual(JSON.parse(storage.getItem('tpanel.my.ui')).favorites, ['embedded-legacy'])
  m.useMy.getState().setLayout('board')
  assert.equal(JSON.parse(storage.getItem('tpanel.my.ui')).fontSize, 'large', 'another preference write retains appearance')
  const savedUi = storage.getItem('tpanel.my.ui')
  storage.setItem('tpanel.my.ui', '{broken')
  m.useMy.getState().syncFontSizeFromStorage()
  assert.equal(m.useMy.getState().fontSize, 'standard', 'invalid storage falls back without corrupting the store')
  assert.equal(m.useMy.getState().layout, 'board', 'appearance synchronization does not replace other preferences')
  storage.setItem('tpanel.my.ui', savedUi)
  m.useMy.getState().syncFontSizeFromStorage()
  assert.equal(m.useMy.getState().fontSize, 'large', 'other-window appearance synchronization uses the persisted value')

  // Read the actual Page type so additions cannot quietly become unreachable.
  const source = ts.createSourceFile('types.ts', readFileSync('src/renderer/src/store/types.ts', 'utf8'), ts.ScriptTarget.Latest, true)
  const pageType = source.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === 'Page')
  assert.ok(pageType && ts.isUnionTypeNode(pageType.type))
  const pages = pageType.type.types.map((node) => node.literal.text).sort()
  assert.deepEqual(Object.keys(m.PAGE_NAVIGATION).sort(), pages)
  const owners = {
    dashboard: 'home', acp: 'agents', channels: 'agents', chat: 'agents',
    tasks: 'tasks', inbox: 'tasks', jira: 'tasks', archive: 'tasks', devtools: 'tasks', architecture: 'tasks', studio: 'tasks',
    team: 'team', analytics: 'team', knowledge: 'knowledge', spec: 'knowledge',
    settings: 'settings', models: 'settings', integrations: 'settings', gateway: 'settings'
  }
  assert.deepEqual(Object.keys(owners).sort(), pages)
  for (const [page, owner] of Object.entries(owners)) assert.equal(m.activeModule(page), owner, `${page} belongs to one stable module`)
  assert.deepEqual(m.PRIMARY_NAVIGATION.map((item) => item.label), ['首页', '智能体', '任务', '团队', '知识'])
  assert.equal(new Set(m.PRIMARY_NAVIGATION.map((item) => item.id)).size, 5)
  for (const page of ['tasks', 'jira', 'team', 'analytics', 'settings']) assert.equal(m.hasShellContext(page), true)
  for (const page of ['dashboard', 'knowledge', 'spec', 'acp', 'channels', 'chat']) assert.equal(m.hasShellContext(page), false, `${page} has no duplicate context browser`)
  assert.equal(m.PAGE_NAVIGATION.chat.scope, 'local', 'moving API Q&A into agents does not change its cross-project history')
  assert.equal(m.PAGE_NAVIGATION.models.scope, 'application')
  assert.equal(m.PAGE_NAVIGATION.gateway.scope, 'mixed')

  assert.equal(m.projectRootKey('C:\\'), 'c:/')
  assert.equal(m.projectRootKey('C:/'), 'c:/')
  assert.equal(m.projectRootKey('\\\\Server\\Share\\Repo\\'), '//server/share/repo')
  assert.equal(m.projectRootKey('C:\\\\Work\\\\Repo\\'), m.projectRootKey('c:/work/repo'))
  assert.equal(m.projectRootKey('\\\\Server\\\\Share\\\\Repo'), '//server/share/repo')
  assert.equal(m.projectRootKey('/'), '/')
  assert.notEqual(m.projectRootKey('/Case/Repo'), m.projectRootKey('/case/repo'))
  assert.equal(m.projectRootKey(' '), null)
  assert.equal(m.projectChoices('D:\\One\\same', ['d:/one/SAME/', 'D:\\Two\\same', 'C:\\', 'c:/']).length, 3)

  const filters = { priority: ['high'], stateGroup: [], assigneeIds: [], labelIds: [] }
  const view = { id: 'same-view-id', name: 'A 的视图', groupBy: 'priority', filters, createdAt: 1 }
  m.saveProjectPreferences('D:\\One\\same', { favorites: ['same-task'], savedViews: [view] }, storage)
  m.saveProjectPreferences('D:\\Two\\same', { favorites: ['different-task'], savedViews: [] }, storage)
  assert.deepEqual(m.loadProjectPreferences('d:/ONE/same/', storage).favorites, ['same-task'])
  assert.deepEqual(m.loadProjectPreferences('D:/Two/same', storage).favorites, ['different-task'])
  const beforePreview = values.size
  m.saveProjectPreferences(null, { favorites: ['preview'], savedViews: [] }, storage)
  assert.equal(values.size, beforePreview)
  assert.deepEqual(m.loadProjectPreferences(null, storage), { favorites: [], savedViews: [] })
  assert.deepEqual(m.loadProjectPreferences('D:/Corrupt', { getItem: () => '{bad', setItem() {} }), { favorites: [], savedViews: [] })

  const snapshot = (root, name) => ({
    meta: { root, name, developer: 'developer' }, archived: [],
    tasks: [{ dirName: 'same-task', path: `${root}/.trellis/tasks/same-task`, date: '2026-10-15', record: { title: `${name} 的任务`, status: 'planning' } }]
  })
  const first = snapshot('D:/One/same', '真实项目 A')
  m.useApp.setState({ snapshot: first, openTaskDir: 'same-task' })
  m.useMy.getState().syncFromSnapshot()
  assert.equal(m.useMy.getState().data.projects[0].name, '真实项目 A')
  assert.equal(m.useApp.getState().openTaskDir, 'same-task', 'initial bootstrap focus survives the first mirror sync')
  assert.deepEqual(m.useMy.getState().favorites, ['same-task'])
  assert.equal(m.useMy.getState().savedViews[0].name, 'A 的视图')
  m.useMy.getState().toggleFilter('priority', 'high')
  m.useMy.getState().setGroupBy('priority')
  m.useMy.getState().setWorkItemsView('iterations')
  assert.equal(m.useMy.getState().groupBy, 'cycle')
  assert.equal(m.activeModule('tasks'), 'tasks', 'iteration is a task view, not another primary module')
  m.useMy.getState().setWorkItemsView('items')
  assert.equal(m.useMy.getState().groupBy, 'priority', 'leaving iterations restores ordinary work grouping')
  m.useMy.getState().setGroupBy('cycle')
  assert.equal(m.useMy.getState().workItemsView, 'items', 'cycle grouping alone never changes navigation identity')
  m.useMy.getState().setWorkItemsTab('active')
  m.useMy.getState().openIssue('same-task')
  m.useMy.getState().setCreateIssueOpen(true)
  m.useApp.setState({ snapshot: { ...first, meta: { ...first.meta, root: 'd:/ONE/same/' } } })
  m.useMy.getState().syncFromSnapshot()
  assert.equal(m.useMy.getState().peekIssueId, 'same-task', 'same canonical root refresh preserves the active selection')
  assert.equal(m.useMy.getState().groupBy, 'cycle')

  m.useApp.setState({ taskExpandOrigin: { fromPage: 'team', taskDir: 'same-task', archived: false, scrollTop: 100 },
    taskMaterialTarget: 'D:/One/same/prd.md', specDocumentTarget: { projectRoot: first.meta.root, path: 'D:/One/same/spec.md' } })
  m.useApp.setState({ snapshot: snapshot('D:/Two/same', '真实项目 B') })
  m.useMy.getState().syncFromSnapshot()
  assert.equal(m.useApp.getState().openTaskDir, null)
  assert.equal(m.useMy.getState().peekIssueId, null)
  assert.equal(m.useMy.getState().workItemsView, 'items')
  assert.equal(m.useMy.getState().workItemsTab, 'all')
  assert.equal(m.useApp.getState().taskExpandOrigin, null)
  assert.equal(m.useApp.getState().taskMaterialTarget, null)
  assert.equal(m.useApp.getState().specDocumentTarget, null)
  assert.equal(m.useMy.getState().createIssueOpen, false)
  assert.equal(m.useMy.getState().groupBy, 'state')
  assert.deepEqual(m.useMy.getState().filters.priority, [])
  assert.deepEqual(m.useMy.getState().favorites, ['different-task'])
  assert.equal(m.useMy.getState().fontSize, 'large', 'project switching does not reset application appearance')
  assert.deepEqual(m.useMy.getState().savedViews, [])
  m.useMy.getState().toggleFavorite('same-task')
  m.useApp.setState({ snapshot: first })
  m.useMy.getState().syncFromSnapshot()
  assert.deepEqual(m.useMy.getState().favorites, ['same-task'])
  assert.equal(m.useMy.getState().savedViews[0].name, 'A 的视图')
  m.useMy.getState().setLayout('list')
  assert.equal(storage.getItem('tpanel.my.favorites'), '["legacy-task"]')
  assert.equal(storage.getItem('tpanel.my.views'), '[{"id":"legacy-view"}]')
  assert.deepEqual(JSON.parse(storage.getItem('tpanel.my.ui')).favorites, ['embedded-legacy'])
  m.useApp.setState({ snapshot: null })
  m.useMy.getState().syncFromSnapshot()
  assert.equal(m.useMy.getState().projectRoot, null)
  assert.deepEqual(m.useMy.getState().favorites, [])
  assert.deepEqual(m.useMy.getState().savedViews, [])

  // Exercise the actual session action with delayed IPC responses, not a copied state machine.
  const deferred = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const historyReads = []
  transport.todoList = async () => ({ ok: true, todos: [] })
  transport.closeProject = async () => {}
  transport.openProject = async (root) => ({ ok: true, snapshot: snapshot(root, root) })
  transport.getSettings = () => {
    const read = deferred()
    historyReads.push(read)
    return read.promise
  }
  m.useApp.setState({ settings: { recentProjects: ['D:/Previous'], theme: 'light' } })
  await m.useApp.getState().openProjectPath('D:/Fresh')
  assert.equal(m.useApp.getState().snapshot.meta.root, 'D:/Fresh', 'project opens before history refresh resolves')
  m.useApp.setState({ settings: { ...m.useApp.getState().settings, theme: 'dark' } })
  historyReads.shift().resolve({ recentProjects: ['D:/Fresh', 'D:/Previous'], theme: 'light' })
  await flush()
  assert.deepEqual(m.useApp.getState().settings.recentProjects, ['D:/Fresh', 'D:/Previous'])
  assert.equal(m.useApp.getState().settings.theme, 'dark', 'history refresh does not overwrite a concurrent preference edit')

  await m.useApp.getState().openProjectPath('D:/A')
  const staleHistory = historyReads.shift()
  await m.useApp.getState().openProjectPath('D:/B')
  historyReads.shift().resolve({ recentProjects: ['D:/B', 'D:/A'], theme: 'light' })
  await flush()
  staleHistory.resolve({ recentProjects: ['D:/A'], theme: 'light' })
  await flush()
  assert.deepEqual(m.useApp.getState().settings.recentProjects, ['D:/B', 'D:/A'], 'old project history cannot overwrite the current list')
  await m.useApp.getState().openProjectPath('D:/FailedHistory')
  historyReads.shift().reject(new Error('unavailable settings'))
  await flush()
  assert.equal(m.useApp.getState().snapshot.meta.root, 'D:/FailedHistory')
  assert.equal(m.useApp.getState().openError, null)
  assert.deepEqual(m.useApp.getState().settings.recentProjects, ['D:/B', 'D:/A'])

  await m.useApp.getState().openProjectPath('D:/Closing')
  const closedHistory = historyReads.shift()
  await m.useApp.getState().closeProject()
  closedHistory.resolve({ recentProjects: ['D:/Closing'], theme: 'light' })
  await flush()
  assert.equal(m.useApp.getState().snapshot, null)
  assert.deepEqual(m.useApp.getState().settings.recentProjects, ['D:/B', 'D:/A'])

  const openResponses = new Map()
  transport.openProject = (root) => {
    const response = deferred()
    openResponses.set(root, response)
    return response.promise
  }
  const oldOpen = m.useApp.getState().openProjectPath('D:/SlowOld')
  const currentOpen = m.useApp.getState().openProjectPath('D:/FastCurrent')
  openResponses.get('D:/FastCurrent').resolve({ ok: true, snapshot: snapshot('D:/FastCurrent', '当前项目') })
  await currentOpen
  openResponses.get('D:/SlowOld').resolve({ ok: true, snapshot: snapshot('D:/SlowOld', '旧项目') })
  await oldOpen
  assert.equal(m.useApp.getState().snapshot.meta.root, 'D:/FastCurrent', 'a late old open response cannot replace the new project')
  assert.equal(historyReads.length, 1)
  historyReads.shift().resolve({ recentProjects: ['D:/FastCurrent'], theme: 'dark' })
  await flush()
  assert.deepEqual(m.useApp.getState().settings.recentProjects, ['D:/FastCurrent'])
  console.log(`Navigation smoke passed: ${pages.length} routes, five primary modules, scope isolation, initial focus and project transitions.`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
