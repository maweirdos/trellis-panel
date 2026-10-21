/** Real Git repositories + actual Electron preload/registered IPC. Unrelated app state/run services are fixtures. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-git-readonly-'))
const absolute = path => resolve(path).replace(/\\/g, '/')

async function nativeChecks() {
  const assert = require('node:assert/strict')
  const fs = require('node:fs')
  const { join } = require('node:path')
  const { createHash } = require('node:crypto')
  const { execFileSync } = require('node:child_process')
  const { app, BrowserWindow } = require('electron')
  const service = require('./boundary.cjs')
  let assertions = 0
  const check = (value, message) => { assert.ok(value, message); assertions++ }
  const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++ }
  const okay = response => { check(response.ok === true, JSON.stringify(response)); return response }
  const denied = (response, code) => { check(response.ok === false && response.code === code, JSON.stringify(response)); return response }
  const git = (root, args, input) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args],
    { cwd: root, input, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).trim()
  const write = (root, path, content) => fs.writeFileSync(join(root, path), content)
  const init = (name, format) => {
    const root = join(__dirname, name)
    fs.mkdirSync(root)
    git(root, ['init', '-q', '-b', 'trunk', ...(format ? ['--object-format=' + format] : [])])
    git(root, ['config', 'user.name', 'Git Smoke 测试'])
    git(root, ['config', 'user.email', 'git-smoke@example.invalid'])
    git(root, ['config', 'core.autocrlf', 'false'])
    git(root, ['config', 'commit.gpgsign', 'false'])
    return root
  }
  const commit = (root, subject) => {
    git(root, ['add', '--all'])
    git(root, ['commit', '-q', '-m', subject])
    return git(root, ['rev-parse', 'HEAD'])
  }
  const snapshot = root => {
    const items = []
    const walk = path => {
      for (const name of fs.readdirSync(path).sort()) {
        const file = join(path, name)
        const stat = fs.lstatSync(file)
        if (stat.isDirectory()) { items.push([file, 'directory']); walk(file) }
        else items.push([file, stat.size, stat.mtimeMs, createHash('sha256').update(fs.readFileSync(file)).digest('hex')])
      }
    }
    walk(root)
    return items
  }
  app.setPath('userData', join(__dirname, 'profile'))
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-background-networking')
  process.env.GIT_CONFIG_GLOBAL = join(__dirname, 'empty-global-config')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '')
  await app.whenReady()
  const root = init('project')
  write(root, '旧 file.txt', 'one\ntwo\nthree\n')
  write(root, 'binary.bin', Buffer.from([0, 1, 2, 3]))
  write(root, 'large.txt', 'old\n')
  const rootHash = commit(root, 'root 提交')
  git(root, ['checkout', '-q', '-b', 'side'])
  write(root, 'side.txt', 'side\n')
  const sideHash = commit(root, 'side commit')
  git(root, ['checkout', '-q', 'trunk'])
  write(root, 'main.txt', 'main\n')
  const mainHash = commit(root, 'main commit')
  git(root, ['merge', '-q', '--no-ff', 'side', '-m', 'merge side'])
  const mergeHash = git(root, ['rev-parse', 'HEAD'])
  git(root, ['mv', '旧 file.txt', 'new 名.txt'])
  const renameHash = commit(root, 'rename unicode path')
  git(root, ['tag', '-a', 'release-one', '-m', 'annotated tag'])
  git(root, ['update-ref', 'refs/remotes/origin/trunk', renameHash])
  const linked = join(__dirname, 'linked-project')
  git(root, ['worktree', 'add', '-q', '--detach', linked, renameHash])
  const empty = init('empty')
  const plain = join(__dirname, 'plain')
  fs.mkdirSync(plain)
  const historyRoot = init('long-history')
  let stream = ''
  for (let i = 0; i < 1005; i++) {
    const subject = 'history ' + i
    stream += 'commit refs/heads/trunk\ncommitter Smoke <smoke@example.invalid> ' + (1700000000 + i) + ' +0000\n' +
      'data ' + Buffer.byteLength(subject) + '\n' + subject + '\ndeleteall\n\n'
  }
  git(historyRoot, ['fast-import', '--quiet'], stream)
  write(root, 'new 名.txt', 'one\nstaged edit\nthree\n')
  git(root, ['add', 'new 名.txt'])
  write(root, 'new 名.txt', 'one\nstaged edit\nunstaged edit\n')
  write(root, 'large.txt', '新内容'.repeat(120000) + '\n')
  write(root, 'binary.bin', Buffer.from([0, 5, 6, 7, 8]))
  write(root, 'untracked 名.txt', 'untracked\n')

  service.setProjectRoot(root)
  service.registerDevtoolsIpc({ getMain: () => null })
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false
  } })
  await window.loadFile(join(__dirname, '../renderer/index.html'))
  const api = (method, ...args) => window.webContents.executeJavaScript('window.trellis.' + method + '(...' + JSON.stringify(args) + ')', true)
  const request = { expectedRoot: root }
  const readHistory = () => api('devtoolsGitHistory', request)
  const getCommit = hash => api('devtoolsGitCommit', { ...request, hash })
  const getDiff = (hash, path) => api('devtoolsGitCommitDiff', { ...request, hash, path })
  try {
    const before = snapshot(root)
    const history = okay(await readHistory())
    equal(history.commits.length, 5, 'root/branches/merge/rename history')
    equal(history.head, renameHash, 'HEAD is full commit ID')
    equal(history.root, root, 'captured root returned')
    check(history.commits.every(commit => Number.isInteger(commit.timestamp) && commit.timestamp > 1e12), 'timestamps use Unix milliseconds')
    check(history.commits.some(commit => commit.author === 'Git Smoke 测试'), 'author Unicode preserved')
    equal(history.commits.find(commit => commit.hash === mergeHash).parents, [mainHash, sideHash], 'merge topology retained')
    check(history.refs.some(ref => ref.kind === 'tag' && ref.name === 'release-one' && ref.hash === renameHash), 'annotated tag peeled')
    check(history.refs.some(ref => ref.kind === 'remote' && ref.name === 'origin/trunk'), 'local remote ref returned')
    check(history.refs.some(ref => ref.kind === 'branch' && ref.name === 'trunk'), 'branch label returned')
    equal([history.hasMore, history.limited, history.nextOffset], [false, false, 5], 'short history finishes truthfully')

    const initial = okay(await getCommit(rootHash))
    equal(initial.parent, null, 'root commit has no parent')
    equal(initial.files.map(file => file.path).sort(), ['binary.bin', 'large.txt', '旧 file.txt'].sort(), 'root commit changed files')
    check(initial.comparison.includes('空树'), 'root comparison explained')
    const initialDiff = okay(await getDiff(rootHash, '旧 file.txt'))
    check(initialDiff.diff.includes('@@ -0,0 +1,3 @@'), 'root text patch compares against empty tree')
    equal([initialDiff.added, initialDiff.removed], [3, 0], 'root diff counts')
    const binary = okay(await getDiff(rootHash, 'binary.bin'))
    check(binary.binary && binary.diff.includes('Binary files'), 'binary patch explicitly marked')

    const merge = okay(await getCommit(mergeHash))
    equal(merge.parent, mainHash, 'merge uses first parent')
    equal(merge.files.map(file => file.path), ['side.txt'], 'first-parent changed files only')
    check(merge.comparison.includes('第一父'), 'merge comparison explained')
    const mergediff = okay(await getDiff(mergeHash, 'side.txt'))
    equal([mergediff.added, mergediff.removed], [1, 0], 'merge diff matches first parent')
    const renamed = okay(await getCommit(renameHash))
    equal(renamed.files, [{ path: 'new 名.txt', oldPath: '旧 file.txt', status: 'R100' }], 'NUL-delimited rename paths preserved')
    const renamediff = okay(await getDiff(renameHash, 'new 名.txt'))
    check(renamediff.diff.includes('rename from') && renamediff.diff.includes('rename to'), 'rename diff includes old and new paths')
    equal([renamediff.added, renamediff.removed], [0, 0], 'pure rename has no invented line changes')

    const status = okay(await api('devtoolsGitStatus'))
    check(status.isRepo && status.branch === 'trunk', 'workspace status recognizes repository')
    check(status.staged.some(file => file.path === 'new 名.txt'), 'staged file available')
    check(status.unstaged.some(file => file.path === 'new 名.txt'), 'unstaged file available')
    check(status.untracked.includes('untracked 名.txt'), 'untracked Unicode name available')
    const staged = okay(await api('devtoolsGitFileDiff', 'new 名.txt', true))
    check(staged.diff.includes('+staged edit') && !staged.diff.includes('+unstaged edit'), 'staged patch uses index')
    const unstaged = okay(await api('devtoolsGitFileDiff', 'new 名.txt', false))
    check(unstaged.diff.includes('+unstaged edit') && !unstaged.diff.includes('+staged edit'), 'unstaged patch uses worktree')
    const large = okay(await api('devtoolsGitFileDiff', 'large.txt', false))
    check(large.truncated && Buffer.byteLength(large.diff) <= 128 * 1024, 'diff capped during reading by UTF-8 bytes')
    check(okay(await api('devtoolsGitFileDiff', 'binary.bin', false)).binary, 'workspace binary diff marked')
    const noDiff = okay(await api('devtoolsGitFileDiff', 'main.txt', false))
    equal([noDiff.diff, noDiff.added, noDiff.removed, noDiff.truncated], ['', 0, 0, false], 'empty patch remains empty')
    denied(await getCommit('HEAD~1'), 'E_INVALID_ARG')
    denied(await getCommit('a'.repeat(40)), 'E_NOT_FOUND')
    denied(await getDiff(renameHash, 'main.txt'), 'E_NOT_FOUND')
    for (const path of ['../main.txt', '/main.txt', 'C:\\main.txt', 'C:main.txt', '', 'a\0b']) {
      denied(await getDiff(renameHash, path), 'E_INVALID_ARG')
      denied(await api('devtoolsGitFileDiff', path, false), 'E_INVALID_ARG')
    }
    denied(await api('devtoolsGitHistory', { expectedRoot: empty }), 'E_CONFLICT')
    denied(await api('devtoolsGitHistory', { ...request, offset: 100 }), 'E_INVALID_ARG')
    denied(await api('devtoolsGitHistory', { ...request, offset: 1, revision: history.revision }), 'E_INVALID_ARG')
    denied(await api('devtoolsGitHistory', null), 'E_INVALID_ARG')
    equal(snapshot(root), before, 'all workspace/index/objects/refs/logs contents and file mtimes unchanged')

    service.setProjectRoot(empty)
    const emptyHistory = okay(await api('devtoolsGitHistory', { expectedRoot: empty }))
    equal([emptyHistory.head, emptyHistory.commits, emptyHistory.hasMore], [null, [], false], 'unborn history is an actual empty result')
    const emptyStatus = okay(await api('devtoolsGitStatus'))
    equal([emptyStatus.isRepo, emptyStatus.branch, emptyStatus.head], [true, 'trunk', null], 'unborn branch does not assume main')
    service.setProjectRoot(linked)
    const detached = okay(await api('devtoolsGitHistory', { expectedRoot: linked }))
    equal(detached.head, renameHash, 'linked .git-file repository accepted')
    equal(okay(await api('devtoolsGitStatus')).branch, null, 'detached HEAD has no fictional branch')
    service.setProjectRoot(plain)
    denied(await api('devtoolsGitHistory', { expectedRoot: plain }), 'E_NOT_FOUND')
    service.setProjectRoot(null)
    denied(await api('devtoolsGitHistory', request), 'E_NO_PROJECT')
    service.setProjectRoot(root)
    const inFlight = service.gitReadonlyHistory(root, request)
    service.setProjectRoot(empty)
    equal(okay(await inFlight).root, root, 'in-flight read keeps captured project root')
    denied(await readHistory(), 'E_CONFLICT')
    service.setProjectRoot(root)
    git(root, ['update-ref', 'refs/heads/new-ref', renameHash])
    denied(await api('devtoolsGitHistory', { ...request, revision: history.revision }), 'E_CONFLICT')
    const newHistory = okay(await readHistory())
    check(newHistory.revision !== history.revision, 'refs-only change invalidates fingerprint')

    const longBefore = snapshot(historyRoot)
    let revision, nextOffset = 0
    const hashes = []
    service.setProjectRoot(historyRoot)
    for (let i = 0; i < 10; i++) {
      const page = okay(await api('devtoolsGitHistory', { expectedRoot: historyRoot, offset: nextOffset, revision }))
      equal(page.commits.length, 100, 'page has 100 commits')
      if (revision) equal(page.revision, revision, 'all ten pages share revision')
      revision = page.revision
      nextOffset = page.nextOffset
      hashes.push(...page.commits.map(commit => commit.hash))
      equal([page.hasMore, page.limited], i === 9 ? [false, true] : [true, false], '1000-commit bound is explicit')
    }
    equal([hashes.length, new Set(hashes).size, nextOffset], [1000, 1000, 1000], 'no repeated commits at page boundary')
    equal(snapshot(historyRoot), longBefore, 'history paging does not alter repository')
    denied(await api('devtoolsGitHistory', { expectedRoot: historyRoot, offset: 1000, revision }), 'E_INVALID_ARG')

    service.setProjectRoot(root)
    const marker = join(__dirname, 'external-command-ran')
    const commandFile = join(__dirname, 'external-command.cjs')
    fs.writeFileSync(commandFile, 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ',"executed");process.stdin.pipe(process.stdout)')
    const command = JSON.stringify(process.execPath.replace(/\\/g, '/')) + ' ' + JSON.stringify(commandFile.replace(/\\/g, '/'))
    git(root, ['config', 'filter.fixture.clean', command])
    git(root, ['config', 'filter.fixture.smudge', command])
    git(root, ['config', 'filter.fixture.process', command])
    git(root, ['config', 'diff.fixture.command', command])
    git(root, ['config', 'diff.fixture.textconv', command])
    git(root, ['config', 'diff.external', command])
    git(root, ['config', 'core.fsmonitor', command])
    write(root, '.gitattributes', '*.txt filter=fixture diff=fixture\n')
    const protectedBefore = snapshot(root)
    const filterStatus = denied(await api('devtoolsGitStatus'), 'E_DENIED')
    check(filterStatus.isRepo === true && filterStatus.error.includes('过滤器'), 'filter denial retains isRepo and readable state so History stays accessible')
    denied(await api('devtoolsGitFileDiff', 'new 名.txt', false), 'E_DENIED')
    okay(await readHistory())
    okay(await getDiff(rootHash, '旧 file.txt'))
    okay(await api('devtoolsGitFileDiff', 'new 名.txt', true))
    check(!fs.existsSync(marker), 'clean/process/textconv/external diff/fsmonitor commands never execute')
    equal(snapshot(root), protectedBefore, 'protected reads do not alter workspace or Git data')

    const direct = await service.readGit(root, ['show', rootHash + ':旧 file.txt'], { maxBytes: 4, allowTruncated: true })
    check(direct.truncated && Buffer.byteLength(direct.out) <= 4, 'reader stops at configured cap')
    await assert.rejects(service.readGit(root, ['show', rootHash + ':旧 file.txt'], { maxBytes: 4 }),
      error => error.code === 'E_IO' && error.message.includes('上限'))
    assertions++

    const pathsRoot = init('path-boundaries')
    write(pathsRoot, 'node', 'one\ntwo\nthree\n')
    write(pathsRoot, 'removed', 'deleted file\n')
    fs.mkdirSync(join(pathsRoot, 'replace'))
    write(pathsRoot, 'replace/child.txt', 'deleted child\n')
    write(pathsRoot, 'blank.txt', 'one\n\nthree\nfour\n')
    commit(pathsRoot, 'path boundary root')
    fs.renameSync(join(pathsRoot, 'node'), join(pathsRoot, 'moving'))
    fs.mkdirSync(join(pathsRoot, 'node'))
    fs.renameSync(join(pathsRoot, 'moving'), join(pathsRoot, 'node/renamed.txt'))
    write(pathsRoot, 'node/other.txt', 'unrelated sibling\n')
    fs.unlinkSync(join(pathsRoot, 'removed'))
    fs.mkdirSync(join(pathsRoot, 'removed'))
    write(pathsRoot, 'removed/child.txt', 'unrelated new child\n')
    fs.unlinkSync(join(pathsRoot, 'replace/child.txt'))
    fs.rmdirSync(join(pathsRoot, 'replace'))
    write(pathsRoot, 'replace', 'replacement file\n')
    write(pathsRoot, 'blank.txt', 'one\n\nthree\nchanged\n')
    const pathsHash = commit(pathsRoot, 'file directory replacements and rename')
    git(pathsRoot, ['config', 'diff.suppressBlankEmpty', 'true'])
    service.setProjectRoot(pathsRoot)
    const pathsBefore = snapshot(pathsRoot)
    const pathDiff = path => api('devtoolsGitCommitDiff', { expectedRoot: pathsRoot, hash: pathsHash, path })
    const scopedRename = okay(await pathDiff('node/renamed.txt'))
    check(scopedRename.diff.includes('rename from node') && !scopedRename.diff.includes('unrelated'), 'renaming into a directory excludes sibling files')
    equal([scopedRename.added, scopedRename.removed], [0, 0], 'scoped rename counts only the selected file')
    const deletedFile = okay(await pathDiff('removed'))
    check(deletedFile.diff.includes('-deleted file') && !deletedFile.diff.includes('unrelated'), 'deleted file path does not expand to its replacement directory')
    equal([deletedFile.added, deletedFile.removed], [0, 1], 'deleted file excludes new descendants')
    const addedFile = okay(await pathDiff('replace'))
    check(addedFile.diff.includes('+replacement file') && !addedFile.diff.includes('deleted child'), 'added file path does not expand to the old directory')
    equal([addedFile.added, addedFile.removed], [1, 0], 'added file excludes old descendants')
    const blankDiff = okay(await pathDiff('blank.txt'))
    check(blankDiff.diff.includes('\n one\n \n three\n-four\n+changed\n'), 'blank context markers are preserved despite repository diff configuration')
    equal(snapshot(pathsRoot), pathsBefore, 'path boundary and configured diff reads do not alter repository data')

    const rawRoot = init('raw-paths')
    const rawStream = 'commit refs/heads/trunk\ncommitter Smoke <smoke@example.invalid> 1700000000 +0000\ndata 4\nroot\n' +
      'M 100644 inline "1\\t2\\tfake.txt"\ndata 8\ncontent\n\n' +
      'commit refs/heads/trunk\ncommitter Smoke <smoke@example.invalid> 1700000001 +0000\ndata 6\nrename\n' +
      'R "1\\t2\\tfake.txt" "3\\t4\\trenamed.txt"\n\n'
    git(rawRoot, ['fast-import', '--quiet'], rawStream)
    const rawHash = git(rawRoot, ['rev-parse', 'HEAD'])
    service.setProjectRoot(rawRoot)
    const rawBefore = snapshot(rawRoot)
    const rawDetail = okay(await api('devtoolsGitCommit', { expectedRoot: rawRoot, hash: rawHash }))
    equal(rawDetail.files, [{ path: '3\t4\trenamed.txt', oldPath: '1\t2\tfake.txt', status: 'R100' }], 'raw tab-separated rename names remain file paths')
    const rawDiff = okay(await api('devtoolsGitCommitDiff', { expectedRoot: rawRoot, hash: rawHash, path: '3\t4\trenamed.txt' }))
    equal([rawDiff.added, rawDiff.removed, rawDiff.binary], [0, 0, false], 'numstat parser skips both rename path tokens instead of counting numeric filenames')
    equal(snapshot(rawRoot), rawBefore, 'raw rename reads do not alter repository data')

    service.setProjectRoot(root)
    const oldPath = process.env.PATH
    try {
      process.env.PATH = ''
      const missing = denied(await readHistory(), 'E_NOT_FOUND')
      check(missing.error.includes('Git'), 'missing Git has understandable message')
    } finally { process.env.PATH = oldPath }
    console.log('GIT_READONLY_PASSED (' + assertions + ' assertions; native Electron + actual preload/registered IPC + real Git; unrelated app state/run services stubbed)')
  } finally { window.destroy() }
}

try {
  for (const path of ['main', 'preload', 'renderer']) mkdirSync(join(directory, path))
  writeFileSync(join(directory, 'renderer/index.html'), '<!doctype html><meta charset="utf-8"><title>Git IPC smoke</title>')
  await build({ entryPoints: ['src/preload/index.ts'], outfile: join(directory, 'preload/index.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning' })
  const fixture = 'let root=null;export const getProjectRoot=()=>root;export const getProjectGeneration=()=>1;export const setProjectRoot=value=>root=value;'
  await build({ stdin: { contents:
    "export {registerDevtoolsIpc} from '" + absolute('src/main/ipc/devtools.ts') + "';" +
    "export * from '" + absolute('src/main/services/devtools-git.ts') + "';" +
    "export {readGit} from '" + absolute('src/main/services/git-readonly-reader.ts') + "';" +
    "export {setProjectRoot} from 'git-fixture';", resolveDir: process.cwd() },
    outfile: join(directory, 'main/boundary.cjs'), bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], logLevel: 'warning', plugins: [{ name: 'unrelated-devtools-services', setup(builder) {
      builder.onResolve({ filter: /^(?:\.\.\/state|git-fixture)$/ }, () => ({ path: 'state', namespace: 'fixture' }))
      builder.onResolve({ filter: /^\.\.\/services\/(?:dev-run|application-confirmation)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'state' ? fixture :
        'export const applicationConfirmation=()=>{};export const devRunGet=()=>{},devRunList=()=>{},devRunStart=()=>{},devRunStop=()=>{},devRunStopAll=()=>{},listPackageScripts=()=>{};' }))
    } }] })
  writeFileSync(join(directory, 'main/test.cjs'), '(' + nativeChecks.toString() +
    ')().then(()=>require("electron").app.exit(0),error=>{console.error(error);require("electron").app.exit(1)});' +
    'setTimeout(()=>{console.error("Git fixture timed out");require("electron").app.exit(1)},90000);')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron')
  const result = await promisify(execFile)(electron, [join(directory, 'main/test.cjs')], {
    env, timeout: 105000, maxBuffer: 2 * 1024 * 1024, windowsHide: true
  })
  assert.ok(result.stdout.includes('GIT_READONLY_PASSED'), result.stdout + result.stderr)
  console.log(result.stdout.trim())
} catch (error) {
  console.error(error.stdout ?? '')
  console.error(error.stderr ?? '')
  throw error
} finally {
  // The exact absolute mkdtemp directory created above; no project or user profile is removed.
  assert.equal(resolve(directory), directory, 'cleanup uses the exact absolute fixture directory')
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()), 'cleanup stays directly under the temporary root')
  assert.ok(directory.split(/[\\/]/).at(-1).startsWith('tpanel-git-readonly-'))
  rmSync(directory, { recursive: true, force: true })
}
