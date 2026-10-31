import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { provisionLocalContentKey } from './team-local-content-key.mjs'

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageDirectories = ['team-service', 'team-web'].map((name) => join(repositoryRoot, 'packages', name))

function requireNode() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 24 || major === 24 && minor < 12) throw Error('Team collaboration requires Node.js >=24.12.0 (including node:sqlite).')
  if (process.versions.electron) throw Error('Run team-local with Node.js, outside the Electron runtime.')
}

function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
  const cli = candidates.find((value) => value && /npm-cli\.js$/i.test(value) && existsSync(value))
  if (!cli) throw Error('npm CLI was not found beside Node.js. Run this command through npm run team:local or npm run team:build.')
  return resolve(cli)
}

async function npm(args, cwd) {
  console.log(`[team] ${basename(cwd)}: npm ${args.join(' ')}`)
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [npmCli(), ...args], { cwd, stdio: 'inherit', windowsHide: true, env: { ...process.env, npm_config_update_notifier: 'false' } })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? done() : reject(Error(`${basename(cwd)} npm ${args.join(' ')} failed (${signal ?? code}).`)))
  })
}

function missingDependencies(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) => !existsSync(join(directory, 'node_modules', name, 'package.json')))
}

export async function buildTeamPackages({ reuse = false } = {}) {
  requireNode()
  for (const directory of packageDirectories) {
    const missing = missingDependencies(directory)
    if (!missing.length) continue
    if (reuse) throw Error(`${basename(directory)} dependencies are missing. Run npm run team:build first.`)
    if (!existsSync(join(directory, 'package-lock.json'))) throw Error(`${basename(directory)} requires its checked-in package-lock.json.`)
    // Each package has an independent lockfile; never install these into the desktop package.
    await npm(['ci', '--include=dev', '--no-audit', '--no-fund'], directory)
  }
  if (!reuse) for (const directory of packageDirectories) await npm(['run', 'build'], directory)
  for (const file of ['packages/team-service/dist/cli.mjs', 'packages/team-service/dist/index.mjs', 'packages/team-service/dist/store-worker.mjs', 'packages/team-web/dist/index.html']) {
    if (!existsSync(join(repositoryRoot, file))) throw Error(`Missing ${file}. Run npm run team:build first.`)
  }
}

// Resolve existing junctions/symlinks even when the final directory has not been created.
function canonicalPath(input) {
  let current = resolve(input)
  const suffix = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) throw Error('The data directory has no existing filesystem root.')
    suffix.unshift(basename(current)); current = parent
  }
  return join(realpathSync(current), ...suffix)
}

export function externalDataDirectory(input) {
  const target = canonicalPath(input)
  const root = canonicalPath(repositoryRoot)
  const fromRoot = relative(root, target)
  if (!fromRoot || !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith('..' + sep)) {
    throw Error('TEAM_DATA_DIR must be outside the repository/worktree. Use the default user data directory or another absolute directory.')
  }
  for (let parent = target;; parent = dirname(parent)) {
    if (existsSync(join(parent, '.git'))) throw Error('TEAM_DATA_DIR resolves inside a Git repository/worktree. Choose an external data directory.')
    if (dirname(parent) === parent) break
  }
  return target
}

export function localTeamEnvironment(env = process.env, platform = process.platform) {
  const mode = env.TEAM_DEPLOYMENT_MODE ?? 'local'
  if (!['local', 'intranet'].includes(mode)) throw Error('TEAM_DEPLOYMENT_MODE must be local or intranet.')
  if (env.TEAM_ALLOW_SELF_REGISTRATION !== undefined && !['0', '1'].includes(env.TEAM_ALLOW_SELF_REGISTRATION)) throw Error('TEAM_ALLOW_SELF_REGISTRATION must be 0 or 1.')
  if (mode === 'intranet' && env.TEAM_ALLOW_SELF_REGISTRATION === undefined) throw Error('Intranet mode requires an explicit TEAM_ALLOW_SELF_REGISTRATION=0 or 1.')
  const port = Number(env.TEAM_PORT ?? 5441)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('TEAM_PORT must be between 1 and 65535.')
  const host = env.TEAM_HOST ?? '127.0.0.1'
  if (!host.trim()) throw Error('TEAM_HOST must be a nonempty bind address.')
  if (mode === 'local' && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw Error('A non-loopback TEAM_HOST requires TEAM_DEPLOYMENT_MODE=intranet and an explicit registration policy.')
  const bindHost = host.includes(':') ? `[${host}]` : host
  const origin = env.TEAM_PUBLIC_ORIGIN ?? `http://${bindHost}:${port}`
  const parsed = new URL(origin)
  if (mode === 'local' && !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw Error('A non-loopback TEAM_PUBLIC_ORIGIN requires TEAM_DEPLOYMENT_MODE=intranet.')
  const home = homedir()
  const base = platform === 'win32' ? env.LOCALAPPDATA ?? join(home, 'AppData', 'Local') : platform === 'darwin' ? join(home, 'Library', 'Application Support') : env.XDG_DATA_HOME ?? join(home, '.local', 'share')
  if (env.TEAM_DATA_DIR !== undefined && !isAbsolute(env.TEAM_DATA_DIR)) throw Error('TEAM_DATA_DIR must be absolute so different working directories use the same database.')
  const dataDir = externalDataDirectory(env.TEAM_DATA_DIR ?? join(base, 'TrellisPanel', 'team-service'))
  return { ...env, TEAM_HOST: host, TEAM_PORT: String(port), TEAM_PUBLIC_ORIGIN: origin, TEAM_DEPLOYMENT_MODE: mode, TEAM_DATA_DIR: dataDir, TEAM_WEB_DIR: resolve(env.TEAM_WEB_DIR ?? join(repositoryRoot, 'packages/team-web/dist')) }
}

export async function assertAvailablePort(host, port) {
  await new Promise((done, reject) => {
    const probe = createServer()
    probe.once('error', (error) => reject(error.code === 'EADDRINUSE' ? Error(`Port ${port} on ${host} is already occupied. Stop its owner yourself or choose TEAM_PORT and TEAM_PUBLIC_ORIGIN; no existing process was stopped.`) : error))
    probe.listen({ host, port, exclusive: true }, () => probe.close((error) => error ? reject(error) : done()))
  })
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('Usage: npm run team:local [-- --no-build]\n       npm run team:build\n\n--no-build   Reuse existing dependencies and both built packages.\n--build-only Install missing locked dependencies and build both packages, then exit.\n\nDefault: http://127.0.0.1:5441; persistent database outside the checkout.\nConfiguration: docs/team-collaboration.md')
    return
  }
  if (args.some((arg) => !['--no-build', '--build-only'].includes(arg)) || args.includes('--no-build') && args.includes('--build-only')) throw Error('Use --no-build or --build-only. See --help.')
  requireNode()
  if (args.includes('--build-only')) { await buildTeamPackages(); return }
  const env = localTeamEnvironment()
  await assertAvailablePort(env.TEAM_HOST, Number(env.TEAM_PORT))
  await buildTeamPackages({ reuse: args.includes('--no-build') })
  const { parseTeamConfig, teamConfigFromEnvironment } = await import(pathToFileURL(join(repositoryRoot, 'packages/team-service/dist/index.mjs')).href)
  parseTeamConfig(teamConfigFromEnvironment(env))
  if (!existsSync(join(env.TEAM_WEB_DIR, 'index.html'))) throw Error('TEAM_WEB_DIR must contain the compiled Web index.html.')
  await assertAvailablePort(env.TEAM_HOST, Number(env.TEAM_PORT))
  Object.assign(process.env, await provisionLocalContentKey(env, externalDataDirectory))
  console.log(`[team] Starting ${env.TEAM_PUBLIC_ORIGIN}\n[team] Data: ${env.TEAM_DATA_DIR}\n[team] Web: ${env.TEAM_WEB_DIR}\n[team] Press Ctrl+C to stop. Register your own account in the Web sign-in page.`)
  // The actual Node CLI owns its SQLite lock and SIGINT/SIGTERM shutdown in this process.
  // Importing avoids an orphaned child service when a Windows terminal is interrupted.
  await import(pathToFileURL(join(repositoryRoot, 'packages/team-service/dist/cli.mjs')).href)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[team] ${error.message}`)
    // A listen race can happen after the preflight. Do not leave the CLI's worker alive.
    process.exit(1)
  })
}
