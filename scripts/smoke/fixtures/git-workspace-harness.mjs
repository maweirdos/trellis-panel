import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

export async function createGitWorkspaceHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'tpanel-git-workspace-'))
  const previous = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
  const config = join(directory, 'global.gitconfig')
  writeFileSync(config, '')
  process.env.GIT_CONFIG_GLOBAL = config
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  const mock = join(directory, 'electron.mjs')
  writeFileSync(mock, `export const app={getPath:()=>${JSON.stringify(directory)}};`)
  const processMock = join(directory, 'child-process.mjs')
  writeFileSync(processMock, `import * as native from 'child_process';export * from 'child_process';let failCleanup=false;export function setTreeCleanupFailure(value){failCleanup=value}export function spawn(executable,...rest){return native.spawn(failCleanup&&/taskkill\\.exe$/i.test(executable)?${JSON.stringify(join(directory, 'missing-cleanup-helper.exe'))}:executable,...rest)}`)
  const entry = join(directory, 'entry.ts')
  writeFileSync(entry, `export * from ${JSON.stringify(resolve('src/main/services/git-workspace/index.ts'))};export * from ${JSON.stringify(resolve('src/main/services/git-workspace/lib/git.ts'))};export * from ${JSON.stringify(resolve('src/main/services/git-workspace/lib/state.ts'))};export {setTreeCleanupFailure} from ${JSON.stringify(processMock)};`)
  await build({ entryPoints: [entry], outfile: join(directory, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', alias: { electron: mock, 'node:child_process': processMock }, nodePaths: [resolve('node_modules')], logLevel: 'warning' })
  const api = createRequire(import.meta.url)(join(directory, 'service.cjs'))
  const service = new api.GitWorkspaceService()
  const git = (root, args, options = {}) => execFileSync('git', args, { cwd: root, env: process.env, windowsHide: true, encoding: 'utf8', ...options }).trimEnd()
  const repository = (name, bare = false) => {
    const root = join(directory, name)
    mkdirSync(root, { recursive: true })
    git(root, ['init', '-q', '-b', 'main', ...(bare ? ['--bare'] : [])])
    if (!bare) {
      git(root, ['config', 'user.name', 'Workspace Fixture'])
      git(root, ['config', 'user.email', 'fixture@example.invalid'])
      git(root, ['config', 'core.autocrlf', 'false'])
    }
    return root
  }
  const status = async root => { const result = await service.status(root); assert.equal(result.ok, true, JSON.stringify(result)); return result.snapshot }
  const input = async (root, extra = {}) => ({ expectedRoot: root, revision: (await status(root)).revision, confirm: true, ...extra })
  const approve = { guard: () => true, review: async () => true }
  return { directory, api, service, git, repository, status, input, approve, close() {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('tpanel-git-workspace-'))
    rmSync(directory, { recursive: true, force: true })
  } }
}
