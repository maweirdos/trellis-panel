import assert from 'node:assert/strict'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGitWorkspaceHarness } from './fixtures/git-workspace-harness.mjs'

const f = await createGitWorkspaceHarness()
const { service, git, repository, status, input, approve } = f
let assertions = 0
const okay = value => { assert.equal(value.ok, true, JSON.stringify(value)); assertions += 1; return value }
const denied = (value, code) => { assert.equal(value.ok, false, JSON.stringify(value)); assert.equal(value.code, code, JSON.stringify(value)); assertions += 1 }
const check = (condition, label) => { assert.ok(condition, label); assertions += 1 }
const initial = async name => {
  const root = repository(name)
  writeFileSync(join(root, 'tracked.txt'), 'initial\n')
  okay(await service.stage(root, await input(root, { paths: ['tracked.txt'] })))
  okay(await service.commit(root, await input(root, { message: 'initial' }), approve))
  return root
}
try {
  const root = await initial('parent boundary')
  const outside = await initial('outside boundary')
  const outsideHead = git(outside, ['rev-parse', 'HEAD'])
  const outsideIndex = readFileSync(join(outside, '.git', 'index'))
  const previous = Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG'].map(key => [key, process.env[key]]))
  try {
    Object.assign(process.env, { GIT_DIR: join(outside, '.git'), GIT_WORK_TREE: outside, GIT_INDEX_FILE: join(outside, '.git', 'index'), GIT_CONFIG: join(outside, '.git', 'config') })
    writeFileSync(join(root, 'tracked.txt'), 'root-only\n')
    okay(await service.stage(root, await input(root, { paths: ['tracked.txt'] })))
    const expected = statSync(root), observed = statSync((await status(root)).repoRoot)
    check(observed.dev === expected.dev && observed.ino === expected.ino, 'inherited Git environment cannot redirect main-derived repository root (including Windows 8.3 aliases)')
    check(readFileSync(join(outside, '.git', 'index')).equals(outsideIndex), 'inherited GIT_INDEX_FILE cannot modify another repository index')
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
  check(git(outside, ['rev-parse', 'HEAD']) === outsideHead && readFileSync(join(outside, 'tracked.txt'), 'utf8') === 'initial\n', 'outside refs and worktree remain unchanged')
  okay(await service.commit(root, await input(root, { message: 'root-only' }), approve))
  git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--', outside, 'nested'])
  okay(await service.commit(root, await input(root, { message: 'fixture submodule' }), approve))
  okay(await service.createBranch(root, await input(root, { name: 'other' })))
  denied(await service.switchBranch(root, await input(root, { name: 'other' })), 'E_DENIED')
  denied(await service.createBranch(root, await input(root, { name: 'no-checkout', switchAfter: true })), 'E_DENIED')
  check(!(await status(root)).branches.some(branch => branch.name === 'no-checkout'), 'unsupported submodule switch fails before creating a branch')
  const nested = join(root, 'nested')
  git(nested, ['config', 'user.name', 'Nested Fixture'])
  git(nested, ['config', 'user.email', 'nested@example.invalid'])
  writeFileSync(join(nested, 'tracked.txt'), 'nested-only\n')
  git(nested, ['add', '--', 'tracked.txt'])
  git(nested, ['commit', '-q', '-m', 'independent nested change'])
  const beforeIndex = readFileSync(join(root, '.git', 'index'))
  denied(await service.stage(root, await input(root, { paths: ['nested'] })), 'E_DENIED')
  check(readFileSync(join(root, '.git', 'index')).equals(beforeIndex), 'unsupported gitlink staging never mutates parent index')
  console.log(`GIT_WORKSPACE_BOUNDARIES_PASSED (${assertions} assertions; inherited Git environment isolation, submodule refusal and unchanged outside repository)`)
} finally { f.close() }
