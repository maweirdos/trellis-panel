/** Mounted Git controls with isolated, typed IPC; never mutates a real repository. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import ts from 'typescript'
import config from '../../tailwind.config.js'

const screenshotIndex = process.argv.indexOf('--screenshots')
const screenshots = screenshotIndex < 0 ? null : process.argv[screenshotIndex + 1]
if (screenshotIndex >= 0) assert.ok(screenshots && isAbsolute(screenshots), '--screenshots requires an absolute path')
if (screenshots) mkdirSync(screenshots, { recursive: true })
const temporary = mkdtempSync(join(tmpdir(), 'tpanel-git-workspace-ui-'))
const absolute = file => resolve(file).replace(/\\/g, '/')
const renderer = 'src/renderer/src/'

async function layoutChecks({ theme, size }) {
  const f = window.gitWorkspaceFixture, passed = []
  const check = (name, condition, detail) => { if (!condition) throw Error(name + ': ' + JSON.stringify(detail)); passed.push(name) }
  const fits = node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 }
  f.mount({ theme, size }); await f.wait(() => f.trigger().getAttribute('aria-label').includes(f.branch), 'real branch label')
  const header = document.querySelector('.my-window-header'), trigger = f.trigger()
  check('true current branch with bounded trigger', trigger.getAttribute('aria-label').includes(f.branch) && fits(trigger) && trigger.offsetWidth <= (innerWidth <= 640 ? 96 : 160), { width: trigger.offsetWidth, box: trigger.getBoundingClientRect().toJSON(), viewport: innerWidth, label: trigger.getAttribute('aria-label') })
  check('header geometry stays 48px', Math.abs(header.getBoundingClientRect().height - 48) < 1)
  check('branch shares global font scale', parseFloat(getComputedStyle(document.querySelector('.my-git-branch-name')).fontSize) === { small: 12, standard: 13, large: 14 }[size])
  trigger.click(); await f.wait(() => document.querySelector('.my-git-branch-menu'), 'menu'); await f.settle()
  check('branch popup fits viewport', fits(document.querySelector('.my-git-branch-menu').parentElement))
  check('branch tooltip never covers the open menu', !document.querySelector('[role="tooltip"]'))
  check('dirty checkout is blocked rather than stashed', f.button('切换到分支 main').disabled && document.body.textContent.includes('处理未提交更改后可切换分支'))
  f.button('更改与提交').click(); await f.wait(() => document.querySelector('.my-git-workspace-panel'), 'panel'); await f.settle()
  const panel = document.querySelector('.my-git-workspace-panel'), style = getComputedStyle(panel)
  check('drawer fits viewport', fits(panel), panel.getBoundingClientRect().toJSON())
  check('drawer border uses shared neutral treatment', ['Top', 'Right', 'Bottom', 'Left'].every(side => style['border' + side + 'Color'] === style.borderTopColor && style['border' + side + 'Width'] === style.borderTopWidth))
  check('drawer uses shared typography and portal root', panel.closest('.my-root') && document.querySelectorAll('.my-root').length === 1 && parseFloat(getComputedStyle(panel.querySelector('h2')).fontSize) === { small: 12, standard: 13, large: 14 }[size])
  check('exact staged and worktree paths remain distinct', document.querySelector('[aria-label="选择工作区文件 src/changed.ts"]') && document.querySelector('[aria-label="选择暂存文件 src/staged.ts"]'))
  f.button('查看工作区差异 src/changed.ts').click(); await f.wait(() => document.querySelector('.my-git-workspace-diff-lines'), 'actual diff')
  const diff = document.querySelector('.my-git-workspace-diff-lines')
  check('diff is real root-scoped and bounded', f.calls.some(([kind, input]) => kind === 'diff' && input.expectedRoot === f.project && input.path === 'src/changed.ts' && !input.staged) && diff.tabIndex === 0 && diff.scrollHeight > diff.clientHeight)
  check('diff status and semantic lines are explicit', document.body.textContent.includes('差异过长，已截断') && document.querySelector('.my-git-workspace-diff-add')?.textContent === '+after' && document.querySelector('.my-git-workspace-diff-remove')?.textContent === '-before')
  const pushOpener = f.button('推送…'); pushOpener.click(); await f.wait(() => document.querySelector('[role="dialog"][aria-label="推送"]'), 'push form'); await f.settle()
  const modal = document.querySelector('[role="dialog"][aria-label="推送"]')
  check('shared push form fits and stays themed', fits(modal) && modal.closest('.my-root'))
  const controls = [...modal.querySelectorAll('button,input,textarea,[tabindex]')].filter(node => node.tabIndex >= 0 && !node.disabled && node.getClientRects().length)
  controls[0].focus(); controls[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
  check('shared modal contains keyboard focus', document.activeElement === controls.at(-1))
  f.escape(); await f.wait(() => !document.querySelector('[role="dialog"][aria-label="推送"]'), 'form Escape')
  await f.settle(); check('push form restores its actual connected opener', document.activeElement === pushOpener, { active: document.activeElement?.outerHTML.slice(0, 300), opener: pushOpener.outerHTML, connected: pushOpener.isConnected })
  check('Escape closes only the top layer without a write', document.querySelector('.my-git-workspace-panel') && !f.calls.some(([kind]) => kind === 'push'))
  const themeRoot = document.querySelector('.my-root'), occupied = Math.round(innerHeight * 0.55)
  themeRoot.style.setProperty('--my-run-dock-occupied-height', occupied + 'px'); await f.settle()
  const changes = document.querySelector('.my-git-workspace-changes')
  const insetProbe = document.createElement('div'); insetProbe.style.height = 'var(--my-shell-inset)'; themeRoot.append(insetProbe)
  const inset = insetProbe.getBoundingClientRect().height; insetProbe.remove()
  check('Git drawer reserves actual running dock height', Math.abs(panel.getBoundingClientRect().bottom - (innerHeight - occupied - inset)) < 2, panel.getBoundingClientRect().toJSON())
  check('maximized dock does not collapse the file scroll region', changes.clientHeight >= 94)
  f.button('推送…').scrollIntoView({ block: 'nearest' }); await f.settle()
  check('short remaining drawer keeps all actions reachable by scroll', f.button('推送…').getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom + 1)
  themeRoot.style.removeProperty('--my-run-dock-occupied-height')
  f.escape(); await f.wait(() => !document.querySelector('.my-git-workspace-panel'), 'drawer Escape'); await f.settle()
  check('drawer restores its connected header opener', document.activeElement === trigger)
  check('document never horizontally overflows', document.documentElement.scrollWidth <= innerWidth + 1)
  return passed
}

async function interactionChecks() {
  const f = window.gitWorkspaceFixture, passed = []
  const check = (name, condition, detail) => { if (!condition) throw Error(name + ': ' + JSON.stringify(detail)); passed.push(name) }
  const loaded = () => f.wait(() => f.trigger().getAttribute('aria-label').includes(f.branch), 'mounted branch')
  const clean = () => f.makeSnapshot({ clean: true, staged: [], unstaged: [], untracked: [] })
  const actions = () => f.calls.filter(([kind]) => !['status', 'diff'].includes(kind))
  const choose = label => { const node = document.querySelector('[aria-label="' + label + '"]'); if (!node) throw Error('Missing checkbox ' + label); node.click() }
  f.mount(); await loaded(); await f.openPanel()
  choose('选择工作区文件 src/changed.ts'); await f.settle()
  const before = f.snapshots.get(f.project).revision
  f.holdAction = true; const stage = f.button('暂存所选'); stage.click(); stage.click()
  await f.wait(() => f.actionRelease && stage.disabled, 'busy stage')
  check('busy stage sends exact reviewed root/revision/paths once', JSON.stringify(actions()) === JSON.stringify([['stage', { expectedRoot: f.project, revision: before, confirm: true, paths: ['src/changed.ts'] }]]), actions())
  check('stage never optimistically moves files', document.querySelector('[aria-label="选择工作区文件 src/changed.ts"]') && !document.querySelector('[aria-label="选择暂存文件 src/changed.ts"]'))
  check('real busy state remains visible in the header', f.trigger().getAttribute('aria-label').includes('正在暂存') && f.trigger().querySelector('.animate-spin'))
  f.actionRelease(); await f.wait(() => document.querySelector('[aria-label="选择暂存文件 src/changed.ts"]'), 'stage result')
  f.holdAction = false; choose('选择暂存文件 src/changed.ts'); await f.settle(); f.button('取消暂存所选').click()
  await f.wait(() => document.querySelector('[aria-label="选择工作区文件 src/changed.ts"]'), 'unstage result')
  check('unstage is manual and exact-path scoped', actions().at(-1)[0] === 'unstage' && actions().at(-1)[1].paths.join() === 'src/changed.ts')
  f.setField('提交说明', 'Keep the staged boundary'); await f.settle(); f.denyCommit = true; f.button('提交暂存内容').click()
  await f.wait(() => document.body.textContent.includes('你取消了本次操作。'), 'native denial'); await f.settle()
  check('denied native review preserves draft and staged files after refresh', document.querySelector('[aria-label="提交说明"]').value === 'Keep the staged boundary' && document.querySelector('[aria-label="选择暂存文件 src/staged.ts"]') && document.body.textContent.includes('你取消了本次操作。'))
  const commitRevision = f.snapshots.get(f.project).revision
  f.denyCommit = false; f.button('提交暂存内容').click(); await f.wait(() => document.querySelector('[aria-label="提交说明"]').value === '', 'confirmed commit')
  check('commit binds the displayed staged snapshot without auto-staging', actions().at(-1)[0] === 'commit' && actions().at(-1)[1].revision === commitRevision && actions().at(-1)[1].message === 'Keep the staged boundary' && actions().filter(([kind]) => kind === 'stage').length === 1)

  f.mount({ snapshot: clean() }); await loaded(); f.trigger().click(); await f.wait(() => document.querySelector('.my-git-branch-menu'), 'clean menu')
  f.button('切换到分支 main').click(); await f.wait(() => document.querySelector('[aria-label="切换分支"]'), 'switch confirm')
  f.button('取消').click(); await f.settle(); check('cancelled branch switch has no side effect', actions().length === 0)
  f.trigger().click(); await f.wait(() => document.querySelector('.my-git-branch-menu'), 'branch menu reopen'); f.button('创建分支…').click(); await f.wait(() => document.querySelector('[aria-label="分支名称"]'), 'create form')
  f.setField('分支名称', 'feature/manual'); await f.settle(); f.button('创建分支').click(); await f.wait(() => f.trigger().getAttribute('aria-label').includes('feature/manual'), 'created branch')
  check('create and optional switch are explicit', actions()[0][0] === 'createBranch' && actions()[0][1].name === 'feature/manual' && actions()[0][1].switchAfter === true && actions()[0][1].confirm === true)
  f.trigger().click(); await f.wait(() => document.querySelector('.my-git-branch-menu'), 'new branch menu'); f.button('切换到分支 main').click(); await f.wait(() => document.querySelector('[aria-label="切换分支"]'), 'switch form'); f.button('切换分支').click()
  await f.wait(() => f.trigger().getAttribute('aria-label') === 'Git 分支：main', 'switched main')
  check('branch switch changes UI only after success', actions().at(-1)[0] === 'switchBranch' && actions().at(-1)[1].name === 'main')
  await f.openPanel(); f.button('推送…').click(); await f.wait(() => document.querySelector('[aria-label="远端分支"]'), 'push dialog'); f.setField('远端分支', 'review/manual'); await f.settle()
  const pushRevision = f.snapshots.get(f.project).revision
  f.button('推送').click(); await f.wait(() => actions().at(-1)?.[0] === 'push' && !document.querySelector('[role="dialog"][aria-label="推送"]'), 'push result')
  check('ordinary push sends selected remote/target only', JSON.stringify(actions().at(-1)[1]) === JSON.stringify({ expectedRoot: f.project, revision: pushRevision, confirm: true, remote: 'origin', branch: 'main', remoteBranch: 'review/manual', setUpstream: false }), actions().at(-1))
  f.button('查看工作区与历史').click(); await f.settle(); check('existing read-only history remains reachable', f.navigation().page === 'devtools' && f.navigation().toolView === 'git')

  const tracking = clean(); tracking.branches[0].upstream = 'fork/releases/review'; tracking.remotes.push({ name: 'fork', fetchUrl: 'https://example.invalid/fork.git', pushUrl: 'https://example.invalid/fork.git' })
  f.mount({ snapshot: tracking }); await loaded(); await f.openPanel(); f.button('推送…').click(); await f.wait(() => document.querySelector('[aria-label="远端分支"]'), 'upstream form')
  check('push defaults honor configured upstream remote and target', f.button('推送远端').textContent.includes('fork') && document.querySelector('[aria-label="远端分支"]').value === 'releases/review')
  f.button('取消').click(); await f.settle(); check('cancelled push form does not call native mutation', actions().length === 0)

  f.mount(); await loaded(); await f.openPanel(); f.setField('提交说明', 'Draft survives conflict'); await f.settle(); f.failMutation = true; f.button('提交暂存内容').click()
  await f.wait(() => document.body.textContent.includes('仓库已变化'), 'revision conflict'); await f.settle()
  check('revision conflict is visible and preserves review scope', document.querySelector('[aria-label="提交说明"]').value === 'Draft survives conflict' && document.querySelector('[aria-label="选择暂存文件 src/staged.ts"]') && document.body.textContent.includes('仓库已变化'))

  f.mount({ snapshot: clean() }); await loaded(); f.trigger().click(); await f.wait(() => document.querySelector('.my-git-branch-menu'), 'stale form menu'); f.button('创建分支…').click(); await f.wait(() => document.querySelector('[aria-label="分支名称"]'), 'stale form')
  f.setField('分支名称', 'feature/stale'); await f.settle(); f.snapshots.set(f.project, clean()); await f.refresh()
  await f.wait(() => document.body.textContent.includes('Git 状态已变化，请关闭后重新查看'), 'stale form blocked')
  check('changed revision cannot silently reauthorize an open form', f.button('创建分支').disabled && actions().length === 0)

  f.mount(); await loaded(); await f.openPanel(); const untrackedDiffCount = f.calls.filter(([kind]) => kind === 'diff').length
  f.button('查看工作区差异 notes/new file.txt').click(); await f.wait(() => document.body.textContent.includes('新文件尚无 Git 基线'), 'untracked file')
  check('untracked files disclose missing baseline without an invalid diff request', f.calls.filter(([kind]) => kind === 'diff').length === untrackedDiffCount)
  f.deferDiff = true; f.button('查看工作区差异 src/changed.ts').click(); await f.wait(() => f.pendingDiff.length === 1, 'binary diff')
  f.pendingDiff[0].resolve({ ok: true, root: f.project, path: 'src/changed.ts', staged: false, added: 0, removed: 0, binary: true, truncated: false, diff: '' }); await f.wait(() => document.body.textContent.includes('二进制文件，未显示文本差异'), 'binary status')
  check('binary diff is not misrepresented as an empty text change', !document.querySelector('.my-git-workspace-diff-lines'))

  f.mount(); await loaded(); await f.openPanel(); f.deferStatus = true; void f.refresh(); await f.wait(() => f.pendingStatus.length === 1, 'pre-mutation status')
  const staleRead = f.pendingStatus[0], oldSnapshot = f.makeSnapshot({ branch: 'STALE_LIST_SENTINEL' })
  choose('选择工作区文件 src/changed.ts'); await f.settle(); f.button('暂存所选').click(); await f.wait(() => document.querySelector('[aria-label="选择暂存文件 src/changed.ts"]'), 'mutation before read')
  staleRead.resolve({ ok: true, root: f.project, snapshot: oldSnapshot }); await f.settle()
  check('late status cannot overwrite the completed mutation', !f.trigger().textContent.includes('STALE_LIST_SENTINEL') && document.querySelector('[aria-label="选择暂存文件 src/changed.ts"]'))

  f.mount(); await loaded(); f.deferStatus = true; void f.refresh(); await f.wait(() => f.pendingStatus.length === 1, 'old A status')
  f.switchRoot(f.other); f.switchRoot(f.project); await f.wait(() => f.pendingStatus.length === 3, 'A B A status generations')
  const replies = [...f.pendingStatus], fresh = f.makeSnapshot({ branch: 'fresh-a' })
  replies[2].resolve({ ok: true, root: f.project, snapshot: fresh }); await f.wait(() => f.trigger().textContent.includes('fresh-a'), 'fresh A')
  replies[0].resolve({ ok: true, root: f.project, snapshot: f.makeSnapshot({ branch: 'old-a' }) }); replies[1].resolve({ ok: true, root: f.other, snapshot: f.makeSnapshot({ root: f.other, branch: 'foreign-b' }) }); await f.settle()
  check('A B A generation rejects all late status replies', f.trigger().textContent.includes('fresh-a') && !document.body.textContent.includes('old-a') && !document.body.textContent.includes('foreign-b'))

  f.mount(); await loaded(); await f.openPanel(); f.deferDiff = true; f.button('查看工作区差异 src/changed.ts').click(); await f.wait(() => f.pendingDiff.length === 1, 'held A diff')
  const lateDiff = f.pendingDiff[0]; f.switchRoot(f.other); f.switchRoot(f.project); await loaded(); await f.openPanel(); f.deferDiff = false; f.button('查看暂存差异 src/staged.ts').click()
  await f.wait(() => document.querySelector('.my-git-workspace-diff-lines'), 'fresh diff')
  lateDiff.resolve({ ok: true, root: f.project, path: 'src/changed.ts', staged: false, added: 1, removed: 0, binary: false, truncated: false, diff: '+LATE_DIFF_SENTINEL' }); await f.settle()
  check('late diff cannot revive after project generation changes', !document.body.textContent.includes('LATE_DIFF_SENTINEL') && document.querySelector('[aria-label="差异 src/staged.ts"]'))
  f.deferDiff = true; f.button('查看工作区差异 src/changed.ts').click(); await f.wait(() => f.pendingDiff.length === 2, 'foreign diff setup')
  f.pendingDiff[1].resolve({ ok: true, root: f.other, path: 'src/changed.ts', staged: false, added: 1, removed: 0, binary: false, truncated: false, diff: '+FOREIGN_DIFF_SENTINEL' }); await f.wait(() => document.body.textContent.includes('差异响应与所选项目或文件不匹配'), 'root-fenced diff')
  check('foreign root diff is rejected even for matching path', !document.body.textContent.includes('FOREIGN_DIFF_SENTINEL'))

  f.mount(); await loaded(); await f.openPanel(); choose('选择工作区文件 src/changed.ts'); await f.settle(); f.holdAction = true; f.button('暂存所选').click(); await f.wait(() => f.actionRelease, 'held mutation')
  const release = f.actionRelease; f.switchRoot(f.other); f.switchRoot(f.project); await loaded(); release(); await f.settle()
  check('late mutation cannot publish success into a later A session', !document.body.textContent.includes('stage 已完成') && !document.querySelector('.my-git-workspace-panel'))
  f.mount(); await loaded(); await f.openPanel(); choose('选择工作区文件 src/changed.ts'); await f.settle(); f.holdAction = true; f.button('暂存所选').click(); await f.wait(() => f.actionRelease, 'unmount mutation')
  const unmountedRelease = f.actionRelease; f.reset(); f.mount(); await loaded(); unmountedRelease('deny'); await f.settle(); await f.openPanel()
  check('unmounted controller cannot publish into a new header instance', !document.body.textContent.includes('你取消了本次操作') && !document.body.textContent.includes('正在暂存'))
  f.mount({ snapshot: f.makeSnapshot({ branch: null, detached: true }) }); await f.wait(() => f.trigger().textContent.includes('分离 HEAD'), 'detached label'); check('detached HEAD is explicit', f.trigger().getAttribute('aria-label').includes('aaaaaaaa'))
  f.mount({ snapshot: f.makeSnapshot({ unborn: true, head: null, staged: [], unstaged: [], untracked: [], clean: true }) }); await f.wait(() => f.trigger().textContent.includes('尚无提交'), 'unborn label'); f.trigger().click(); await f.wait(() => document.querySelector('.my-git-branch-menu'), 'unborn menu'); check('unborn branch cannot create from a nonexistent commit', f.button('创建分支…').disabled)
  f.mount(); await loaded(); f.statusFailure = true; await f.refresh(); await f.wait(() => f.trigger().textContent.includes('非 Git 仓库'), 'no repository'); check('no-repo is not fabricated as main', !f.trigger().textContent.includes('main'))
  f.mount({ ipc: false }); await f.settle(); await f.openPanel(); check('missing IPC degrades without invoking Git', f.calls.length === 0 && document.body.textContent.includes('桌面端可查看项目 Git'))
  f.mount({ path: null }); await f.settle(); await f.openPanel(); check('no project has explicit empty state and no writes', document.body.textContent.includes('选择项目后查看更改') && actions().length === 0)
  f.reset()
  return passed
}

try {
  const entry = resolve('scripts/smoke/fixtures/git-workspace-ui.tsx')
  const appStore = join(temporary, 'app-store.d.ts'), myStore = join(temporary, 'my-store.d.ts'), apiTypes = join(temporary, 'api.d.ts')
  const storeTypes = ts.createSourceFile('store-types.ts', readFileSync(renderer + 'store/types.ts', 'utf8'), ts.ScriptTarget.Latest, true)
  const pageType = storeTypes.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'Page')
  assert.ok(pageType, 'fixture must use the actual route union')
  writeFileSync(appStore, `${pageType.getText(storeTypes)};interface State{snapshot:{meta:{root:string;name:string}}|null;page:Page;setPage(page:Page):void}export const useApp:{<T>(select:(state:State)=>T):T;getState():State;setState(state:Partial<State>):void;subscribe(listener:(state:State)=>void):()=>void};`)
  writeFileSync(myStore, `interface State{toolView:string;setToolView(view:string):void}export const useMy:{<T>(select:(state:State)=>T):T;getState():State};`)
  writeFileSync(apiTypes, `import type{GitWorkspaceApi}from '${absolute('src/shared/git-workspace')}';export let hasIpc:boolean;export function setCapability(value:boolean):void;export const api:{gitWorkspace:GitWorkspaceApi};`)
  const parsed = ts.getParsedCommandLineOfConfigFile(resolve('tsconfig.web.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) } })
  assert.ok(parsed)
  const host = ts.createCompilerHost(parsed.options)
  host.resolveModuleNames = (names, file) => names.map(name => {
    const path = absolute(resolve(dirname(file), name))
    const mock = path === absolute(renderer + 'store') ? appStore : path === absolute(renderer + 'my/store') ? myStore : path === absolute(renderer + 'api') ? apiTypes : null
    return mock ? { resolvedFileName: mock, extension: ts.Extension.Dts } : ts.resolveModuleName(name, file, parsed.options, host).resolvedModule
  })
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([entry], parsed.options, host))
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' }))
  process.stdout.write('PASS isolated TypeScript check of actual Git UI and GitWorkspaceApi fixture\n')
  await build({ entryPoints: [entry], outfile: join(temporary, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'isolated-git-workspace-fixture', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      if (args.path.startsWith('@shared/')) return { path: absolute('src/shared/' + args.path.slice(8) + '.ts') }
      if (args.path.endsWith('.svg?url')) return { path: resolve(dirname(args.importer), args.path.replace(/\?url$/, '')) }
      const path = absolute(resolve(dirname(args.importer || entry), args.path))
      if (path === absolute(renderer + 'store')) return { path: 'store', namespace: 'fixture' }
      if (path === absolute(renderer + 'my/store')) return { path: 'my-store', namespace: 'fixture' }
      if (path === absolute(renderer + 'api')) return { path: 'api', namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: process.cwd(), contents: args.path === 'store'
      ? `import{create}from '${absolute('node_modules/zustand/esm/index.mjs')}';export const useApp=create(set=>({snapshot:null,page:'dashboard',setPage:page=>set({page})}));`
      : args.path === 'my-store' ? `import{create}from '${absolute('node_modules/zustand/esm/index.mjs')}';export const useMy=create(set=>({toolView:'terminal',setToolView:toolView=>set({toolView})}));`
        : `export let hasIpc=true;export function setCapability(value){hasIpc=value}export const api={get gitWorkspace(){return window.__gitWorkspaceApi}};` }))
  } }] })
  const sheets = ['my/my-tokens.css', 'my/my-components.css', 'my/my-feedback.css', 'my/my-shell.css', 'my/my-utilities.css', 'git-workspace/git-workspace.css', 'styles.css']
  const css = (await postcss([tailwind(config)]).process(sheets.map(file => readFileSync(renderer + file, 'utf8')).join('\n'), { from: undefined })).css
  writeFileSync(join(temporary, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${css}html,body,#root{height:100%;margin:0}.git-fixture-header{height:48px;display:flex;align-items:center;gap:var(--my-space-8);padding-inline:var(--my-space-8)}.git-fixture-header-space{flex:1;min-width:0}.git-fixture-body{padding:var(--my-page-inset);color:var(--my-txt-tertiary)}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  const serialize = fn => JSON.stringify('(' + fn.toString() + ')')
  writeFileSync(join(temporary, 'main.cjs'), `const{app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const{writeFileSync}=require('node:fs');const{join}=require('node:path');
app.setPath('userData',${JSON.stringify(join(temporary, 'profile'))});app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
const layout=${serialize(layoutChecks)},interactions=${serialize(interactionChecks)},screenshots=${JSON.stringify(screenshots)};
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,frame:false,width:960,height:720,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false,offscreen:Boolean(screenshots)}});const errors=[];w.webContents.on('console-message',details=>{if(details.level==='error'){errors.push(details.message);console.error(details.message)}});w.webContents.on('render-process-gone',(_event,details)=>{console.error(details);app.exit(1)});await w.loadFile(${JSON.stringify(join(temporary, 'index.html'))});
w.webContents.debugger.attach('1.3');await w.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
const evaluate=(fn,arg)=>w.webContents.executeJavaScript(fn+'('+JSON.stringify(arg??null)+')');
const resize=async(width,height)=>{w.setContentSize(width,height);for(let i=0;i<30;i++){const size=await w.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');if(size.width===width&&size.height===height){await new Promise(done=>setTimeout(done,80));return;}await new Promise(done=>setTimeout(done,20))}throw Error('viewport resize timed out')};
// Wait for the committed state and compositor, not the next possibly stale offscreen paint.
const capture=async name=>{if(!screenshots)return;await w.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');await new Promise(done=>setTimeout(done,250));const state=await w.webContents.executeJavaScript('({theme:document.querySelector(".my-root").dataset.myTheme,size:document.querySelector(".my-root").dataset.myFontSize})');assert.equal(state.theme,name.split('-')[0],'capture theme matches requested state');assert.equal(state.size,name.split('-')[1],'capture font matches requested state');const result=await w.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const path=join(screenshots,name+'.png');writeFileSync(path,Buffer.from(result.data,'base64'));console.log('SCREENSHOT '+path)};
let count=0;for(const[width,height]of [[960,720],[360,620]]){await resize(width,height);for(const theme of ['light','dark'])for(const size of ['small','standard','large']){const checks=await evaluate(layout,{theme,size});count+=checks.length;console.log('PASS '+theme+'/'+size+'/'+width+'x'+height+': '+checks.length+' mounted layout checks');if(screenshots&&(size==='standard'||(width===360&&size==='large'))){await w.webContents.executeJavaScript('window.gitWorkspaceFixture.trigger().click();window.gitWorkspaceFixture.settle()');await capture(theme+'-'+size+'-'+width+'x'+height+'-branches');await w.webContents.executeJavaScript('window.gitWorkspaceFixture.button("更改与提交").click();window.gitWorkspaceFixture.settle()');await w.webContents.executeJavaScript('window.gitWorkspaceFixture.button("查看工作区差异 src/changed.ts").click();window.gitWorkspaceFixture.wait(()=>document.querySelector(".my-git-workspace-diff-lines"),"diff screenshot")');await capture(theme+'-'+size+'-'+width+'x'+height+'-changes');await w.webContents.executeJavaScript('document.querySelector(".my-root").style.setProperty("--my-run-dock-occupied-height",Math.round(innerHeight*.55)+"px");window.gitWorkspaceFixture.button("推送…").scrollIntoView({block:"nearest"});window.gitWorkspaceFixture.settle()');await capture(theme+'-'+size+'-'+width+'x'+height+'-changes-max-dock');await w.webContents.executeJavaScript('document.querySelector(".my-root").style.removeProperty("--my-run-dock-occupied-height");window.gitWorkspaceFixture.settle()');await w.webContents.executeJavaScript('window.gitWorkspaceFixture.button("推送…").click();window.gitWorkspaceFixture.settle()');await capture(theme+'-'+size+'-'+width+'x'+height+'-push');}}}
await resize(960,720);const checks=await evaluate(interactions);checks.forEach(name=>console.log('PASS '+name));assert.deepEqual(errors,[],'renderer console errors');assert.equal(w.isVisible(),false);console.log('Git workspace UI smoke passed: '+count+' mounted layout checks and '+checks.length+' write/cancel/race checks.');w.destroy();app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});setTimeout(()=>{console.error('Git UI fixture timed out');app.exit(1)},65000);`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), [join(temporary, 'main.cjs'), '--no-sandbox'], { env, windowsHide: true, timeout: 75000, maxBuffer: 2 * 1024 * 1024 })
  process.stdout.write(result.stdout)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  const resolved = resolve(temporary)
  assert.equal(dirname(resolved), resolve(tmpdir()))
  assert.ok(basename(resolved).startsWith('tpanel-git-workspace-ui-'))
  rmSync(resolved, { recursive: true, force: true })
}
