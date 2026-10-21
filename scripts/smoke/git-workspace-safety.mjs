import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGitWorkspaceHarness } from './fixtures/git-workspace-harness.mjs'

const f = await createGitWorkspaceHarness()
const { service, git, repository, status, input, approve, api } = f
let assertions = 0
const check = (value, label) => { assert.ok(value, label); assertions += 1 }
const okay = value => { assert.equal(value.ok, true, JSON.stringify(value)); assertions += 1; return value }
const denied = (value, code) => { assert.equal(value.ok, false, JSON.stringify(value)); if (code) assert.equal(value.code, code, JSON.stringify(value)); assertions += 1; return value }
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const hook = (root, name, source) => {
  const script = join(root, '.git', `${name}-fixture.cjs`)
  const executable = join(root, '.git', 'hooks', name)
  writeFileSync(script, source)
  writeFileSync(executable, `#!/bin/sh\n"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}" "$@"\n`)
  chmodSync(executable, 0o755)
  return () => { rmSync(executable, { force: true }); rmSync(script, { force: true }) }
}
const initial = async name => {
  const root = repository(name)
  writeFileSync(join(root, 'tracked.txt'), 'one\n')
  okay(await service.stage(root, await input(root, { paths: ['tracked.txt'] })))
  okay(await service.commit(root, await input(root, { message: 'initial' }), approve))
  return root
}
try {
  const root = await initial('safety repository')
  writeFileSync(join(root, 'tracked.txt'), 'two\n')
  writeFileSync(join(root, 'extra.txt'), 'unreviewed\n')
  okay(await service.stage(root, await input(root, { paths: ['tracked.txt'] })))
  const head = git(root, ['rev-parse', 'HEAD'])
  const originalIndex = readFileSync(join(root, '.git', 'index'))
  let remove = hook(root, 'pre-commit', `require('node:child_process').execFileSync('git',['add','--','extra.txt'],{env:process.env});`)
  denied(await service.commit(root, await input(root, { message: 'no hidden staging' }), approve), 'E_CONFLICT')
  check(git(root, ['rev-parse', 'HEAD']) === head && readFileSync(join(root, '.git', 'index')).equals(originalIndex), 'hook staging affects private index only; no ref or live index changed')
  check(git(root, ['diff', '--cached', '--name-only']) === 'tracked.txt', 'unreviewed hook-staged file excluded from live index')
  remove()
  remove = hook(root, 'commit-msg', `require('node:fs').appendFileSync(process.argv[2],'modified by hook\\n');`)
  denied(await service.commit(root, await input(root, { message: 'exact message' }), approve), 'E_CONFLICT')
  check(git(root, ['rev-parse', 'HEAD']) === head, 'rewritten commit message is not silently committed')
  remove()
  remove = hook(root, 'pre-commit', `process.stderr.write('fixture rejected');process.exit(1);`)
  denied(await service.commit(root, await input(root, { message: 'rejected' }), approve), 'E_IO')
  check(git(root, ['rev-parse', 'HEAD']) === head && !existsSync(join(root, '.git', 'index.lock')), 'failed pre-commit hook leaves no commit or leaked lock')
  remove()
  const concurrentHead = git(root, ['commit-tree', `${head}^{tree}`, '-p', head, '-m', 'independent ref advance'])
  remove = hook(root, 'pre-commit', `require('node:child_process').execFileSync('git',['update-ref','HEAD',${JSON.stringify(concurrentHead)},${JSON.stringify(head)}],{env:process.env});`)
  denied(await service.commit(root, await input(root, { message: 'ref changed during hook' }), approve), 'E_CONFLICT')
  check(git(root, ['rev-parse', 'HEAD']) === concurrentHead && readFileSync(join(root, '.git', 'index')).equals(originalIndex), 'concurrent hook ref advance is preserved, never overwritten by a reviewed stale parent')
  remove()
  git(root, ['update-ref', 'HEAD', head, concurrentHead])
  let stillCurrent = true
  denied(await service.commit(root, await input(root, { message: 'guard changed in review' }), { guard: () => stillCurrent, review: async () => { stillCurrent = false; return true } }), 'E_CONFLICT')
  check(git(root, ['rev-parse', 'HEAD']) === head, 'generation guard is rechecked after native review before hooks or commit creation')
  const hookLog = join(root, '.git', 'hook.log')
  const removers = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'].map(name => hook(root, name, `require('node:fs').appendFileSync(${JSON.stringify(hookLog)},${JSON.stringify(name + '\n')});`))
  okay(await service.commit(root, await input(root, { message: 'hooks executed' }), approve))
  check(readFileSync(hookLog, 'utf8') === 'pre-commit\nprepare-commit-msg\ncommit-msg\npost-commit\n', 'all native commit hooks run in order')
  removers.forEach(removeHook => removeHook())
  writeFileSync(join(root, 'tracked.txt'), 'three\n')
  okay(await service.stage(root, await input(root, { paths: ['tracked.txt'] })))
  remove = hook(root, 'post-commit', 'process.exit(1);')
  const completed = denied(await service.commit(root, await input(root, { message: 'post hook failed' }), approve), 'E_IO')
  check(completed.mutationCompleted && completed.committed === git(root, ['rev-parse', 'HEAD']), 'post-hook failure truthfully reports successful exact commit')
  remove()
  unlinkSync(join(root, 'extra.txt'))

  writeFileSync(join(root, 'tracked.txt'), 'four\n')
  okay(await service.stage(root, await input(root, { paths: ['tracked.txt'] })))
  writeFileSync(join(root, 'queued.txt'), 'queued\n')
  mkdirSync(join(root, 'subdirectory'))
  let enterReview, releaseReview
  const entered = new Promise(resolve => { enterReview = resolve })
  const released = new Promise(resolve => { releaseReview = resolve })
  const pendingCommit = service.commit(root, await input(root, { message: 'cancel queued operation' }), { review: async () => { enterReview(); await released; return false } })
  await entered
  let current = true, queuedFinished = false
  const subdirectory = join(root, 'subdirectory')
  const pendingStage = service.stage(subdirectory, await input(subdirectory, { paths: ['queued.txt'] }), { guard: () => current }).finally(() => { queuedFinished = true })
  await delay(150)
  check(!queuedFinished, 'same repository subdirectory shares queue while native review is open')
  current = false
  releaseReview()
  denied(await pendingCommit, 'E_DENIED')
  denied(await pendingStage, 'E_CONFLICT')
  check(git(root, ['diff', '--cached', '--name-only']) === 'tracked.txt', 'obsolete queued request does not stage after generation change')
  okay(await service.commit(root, await input(root, { message: 'four' }), approve))
  unlinkSync(join(root, 'queued.txt'))

  okay(await service.createBranch(root, await input(root, { name: 'checkout-hook-failure' })))
  remove = hook(root, 'post-checkout', 'process.stderr.write("fixture post-checkout rejected");process.exit(1);')
  const switchedWithFailure = denied(await service.switchBranch(root, await input(root, { name: 'checkout-hook-failure' })), 'E_IO')
  check(switchedWithFailure.mutationCompleted && (await status(root)).branch === 'checkout-hook-failure', 'failed post-checkout truthfully reports that the branch already switched')
  remove()
  okay(await service.switchBranch(root, await input(root, { name: 'main' })))

  writeFileSync(join(root, 'tracked.txt'), 'five\n')
  const lock = join(root, '.git', 'index.lock')
  writeFileSync(lock, 'foreign lock')
  denied(await service.stage(root, await input(root, { paths: ['tracked.txt'] })), 'E_CONFLICT')
  check(readFileSync(lock, 'utf8') === 'foreign lock', 'existing external index lock is never removed')
  unlinkSync(lock)
  denied(await service.stage(root, { ...await input(root, { paths: ['tracked.txt'] }), force: true }), 'E_INVALID_ARG')
  unlinkSync(join(root, 'tracked.txt'))
  mkdirSync(join(root, 'tracked.txt'))
  writeFileSync(join(root, 'tracked.txt', 'hidden.txt'), 'must not recurse\n')
  okay(await service.stage(root, await input(root, { paths: ['tracked.txt'] })))
  check(git(root, ['diff', '--cached', '--name-only']) === 'tracked.txt' && (await status(root)).untracked.includes('tracked.txt/hidden.txt'), 'selected file-to-directory deletion never recursively stages replacement children')
  okay(await service.commit(root, await input(root, { message: 'delete replaced file' }), approve))
  rmSync(join(root, 'tracked.txt'), { recursive: true })

  const bare = repository('nonfastforward.git', true)
  git(root, ['remote', 'add', 'origin', bare])
  okay(await service.push(root, await input(root, { remote: 'origin', branch: 'main', remoteBranch: 'main' }), approve))
  const remoteHead = git(root, ['rev-parse', 'HEAD'])
  const advanced = git(bare, ['-c', 'user.name=Remote Fixture', '-c', 'user.email=remote@example.invalid', 'commit-tree', `${remoteHead}^{tree}`, '-p', remoteHead, '-m', 'independent remote advance'])
  git(bare, ['update-ref', 'refs/heads/main', advanced, remoteHead])
  denied(await service.push(root, await input(root, { remote: 'origin', branch: 'main', remoteBranch: 'main' }), approve), 'E_CONFLICT')
  check(git(bare, ['rev-parse', 'refs/heads/main']) === advanced, 'nonfastforward refusal preserves remote tip; no force fallback')
  git(root, ['remote', 'add', 'secret', 'https://alice:private@host.invalid/repo?token=hidden'])
  check(!JSON.stringify((await status(root)).remotes).includes('private') && !JSON.stringify((await status(root)).remotes).includes('hidden'), 'remote display redacts embedded passwords and tokens')
  check(api.redactGitText('https://alice:p@ss@host.invalid/repo') === 'https://[REDACTED]@host.invalid/repo', 'redaction handles multiple credential at signs')
  git(root, ['remote', 'add', 'ssh-secret', 'ssh://alice:private@host.invalid/repo'])
  check(!JSON.stringify((await status(root)).remotes).includes('private'), 'non-HTTP remote credentials never reach the UI projection')

  const filtered = await initial('external filter')
  const marker = join(filtered, '.git', 'filter-executed')
  const filterScript = join(filtered, '.git', 'filter.cjs')
  writeFileSync(filterScript, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');process.stdin.pipe(process.stdout);`)
  git(filtered, ['config', 'filter.fixture.clean', `"${process.execPath.replaceAll('\\', '/')}" "${filterScript.replaceAll('\\', '/')}"`])
  writeFileSync(join(filtered, '.gitattributes'), '*.txt filter=fixture\n')
  denied(await service.status(filtered), 'E_DENIED')
  check(!existsSync(marker), 'status refuses active external clean/process filters without executing them')

  const timed = repository('bounded hook')
  const timeoutMarker = join(timed, '.git', 'timeout-worker')
  remove = hook(timed, 'pre-commit', `require('node:fs').writeFileSync(${JSON.stringify(timeoutMarker)},String(process.pid));setInterval(()=>{},1000);`)
  let start = Date.now(), timeoutError
  try { await api.runGit(timed, ['hook', 'run', 'pre-commit'], { timeoutMs: 1000 }) } catch (error) { timeoutError = error }
  check(timeoutError?.code === 'E_TIMEOUT' && timeoutError.extra.uncertain && Date.now() - start < 4000, 'hook process tree timeout settles within bounded deadline')
  const worker = Number(readFileSync(timeoutMarker, 'utf8'))
  await delay(100)
  let alive = true
  try { process.kill(worker, 0) } catch { alive = false }
  if (alive) { try { process.kill(worker) } catch { /* Only the fixture's own PID is eligible. */ } }
  check(!alive && !timeoutError.retainIndexLock, 'owned Git hook descendant terminated before safe cleanup')
  remove()
  if (process.platform === 'win32') {
    writeFileSync(join(timed, 'staged.txt'), 'retained private snapshot\n')
    okay(await service.stage(timed, await input(timed, { paths: ['staged.txt'] })))
    const exactIndex = readFileSync(join(timed, '.git', 'index'))
    remove = hook(timed, 'pre-commit', `require('node:fs').writeFileSync(${JSON.stringify(timeoutMarker)},String(process.pid));process.stderr.write('x'.repeat(65536));setInterval(()=>{},1000);`)
    start = Date.now()
    let retained
    try {
      // Fixture-only spawn adapter simulates missing taskkill without changing OS environment.
      api.setTreeCleanupFailure(true)
      retained = await service.commit(timed, await input(timed, { message: 'must retain lock' }), approve)
    } finally {
      api.setTreeCleanupFailure(false)
      const owned = Number(readFileSync(timeoutMarker, 'utf8'))
      try { process.kill(owned) } catch { /* The fixture may already have ended. */ }
      remove()
    }
    denied(retained, 'E_IO')
    check(retained.uncertain && Date.now() - start < 15000, `unverified pipe-holding helper fails within bounded time with uncertain outcome: ${JSON.stringify(retained)}`)
    check(existsSync(join(timed, '.git', 'index.lock')) && readdirSync(join(timed, '.git')).some(name => name.startsWith('tpanel-workspace-')), 'unsafe hook cleanup preserves the owned real-index lock and private transaction directory')
    check(readFileSync(join(timed, '.git', 'index')).equals(exactIndex) && (await status(timed)).unborn, 'uncertain hook leaves reviewed live index and unborn ref unchanged')
  }
  console.log(`GIT_WORKSPACE_SAFETY_PASSED (${assertions} assertions; native hooks, exact message/index, shared queue generation, foreign lock, nonfastforward, filters and bounded process trees)`)
} finally { f.close() }
