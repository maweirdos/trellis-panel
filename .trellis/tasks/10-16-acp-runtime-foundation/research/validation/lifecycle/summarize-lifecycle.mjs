// Original assertions over preserved public-API experiment artifacts.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const main = read(join(root, 'runs/2026-10-16T10-09-00-530Z/summary.json'))
const spawn = read(join(root, 'runs/2026-10-16T10-10-13-238Z/summary.json'))
const reconnect = read(join(root, 'runs/2026-10-16T10-10-52-264Z/summary.json'))
const selected = new Map(main.cases.map((entry) => [entry.caseName, entry]))
selected.set('spawn_failure', spawn.cases[0])
selected.set('cancel_reconnect_startup', reconnect.cases[0])
const results = []
for (const [name, entry] of selected) {
  const result = read(join(entry.root, 'result.json'))
  const supervisor = read(join(entry.root, 'supervisor.json'))
  const hooks = result.lifecycle.map((event) => event.kind)
  const requests = result.fixture.filter((event) => event.kind === 'request').map((event) => event.method)
  assert.equal(supervisor.completed.code, 0, `${name}: worker settles within outer deadline`)
  assert.ok(supervisor.afterCleanup.every((process) => !process.alive), `${name}: no known owned process remains`)
  assert.ok(supervisor.ownership.every((process) => !process.alive), `${name}: no supervisor force-cleanup required in selected run`)
  assert.ok(!result.fixture.some((event) => ['agent_self_exit', 'grandchild_self_exit'].includes(event.kind)), `${name}: self-exit watchdog did not produce the passing result`)
  if (name === 'explicit_paths_restricted_path') {
    assert.equal(result.turnResult.status, 'completed')
    const start = result.fixture.find((event) => event.kind === 'agent_started')
    assert.equal(start.restrictedPath, true)
    assert.ok(start.execPath.includes('Node Runtime With Spaces'))
    assert.equal(start.argv.at(-1), 'literal spaces & metacharacters')
    assert.ok(requests.includes('session/prompt'))
  } else if (name === 'init_failure') {
    assert.equal(result.error.code, -32603)
    assert.deepEqual(hooks, ['before', 'spawned', 'exit'])
  } else if (name === 'spawn_failure') {
    assert.equal(result.error.cause.code, 'ENOENT')
    assert.deepEqual(hooks, ['before', 'spawn_failed'])
    assert.equal(result.fixture.length, 0)
  } else if (name === 'before_hook_reject') {
    assert.match(result.error.message, /before-hook rejection/)
    assert.deepEqual(hooks, ['before'])
    assert.equal(result.fixture.length, 0)
  } else if (name === 'spawned_hook_reject') {
    assert.match(result.error.message, /spawned-hook rejection/)
    assert.deepEqual(hooks, ['before', 'spawned', 'exit'])
  } else if (name === 'cancel_turn' || name === 'shutdown_busy') {
    assert.equal(result.turnResult.status, 'cancelled')
    assert.ok(requests.includes('session/cancel'))
  } else if (name === 'shutdown_startup') {
    assert.ok(result.ensureAfterShutdown.error)
    assert.ok(!requests.includes('session/new'))
  } else if (name === 'cancel_reconnect_startup') {
    assert.equal(result.turnResult.status, 'cancelled')
    assert.ok(requests.includes('session/load'))
    assert.ok(!requests.includes('session/prompt'))
  } else if (name === 'shutdown_grandchild') {
    assert.ok(result.fixture.some((event) => event.kind === 'grandchild_started'))
    assert.equal(result.aliveAfterRuntimeShutdown.length, 2)
    assert.ok(result.aliveAfterRuntimeShutdown.every((process) => !process.alive))
  } else if (name === 'cmd_launcher') {
    assert.equal(result.outcome, 'ensure-resolved')
    assert.ok(result.lifecycle[0].command.toLowerCase().endsWith('cmd.exe'))
    assert.ok(result.fixture.some((event) => event.kind === 'agent_started'))
  } else assert.equal(result.outcome, 'case-settled')
  const actionAt = result.actionAt ?? result.cancelAt ?? result.shutdownAt
  const exits = result.lifecycle.filter((event) => event.kind === 'exit')
  const lastExit = exits.at(-1)
  results.push({
    name, status: 'passed', path: entry.root, durationMs: result.durationMs,
    hooks, requests,
    completion: result.turnResult ?? result.ensureAfterShutdown ?? result.outcome,
    actionToLastAgentExitMs: actionAt && lastExit ? lastExit.at - actionAt : undefined,
    actionToReportMs: actionAt ? result.finishedAt - actionAt : undefined,
    ownedPids: supervisor.afterCleanup.map((process) => process.pid)
  })
}
const files = ['agent fixture.mjs', 'agent-entry.mjs', 'run-lifecycle.mjs', 'summarize-lifecycle.mjs']
const report = {
  schema: 'trellis.acpx-lifecycle-experiment.v1', date: '2026-10-16', package: 'acpx@0.19.5',
  node: process.version, platform: process.platform,
  sources: files.map((name) => ({ name, sha256: createHash('sha256').update(readFileSync(join(root, name))).digest('hex') })),
  selectedRuns: [main.runRoot, spawn.runRoot, reconnect.runRoot],
  note: 'Earlier diagnostic runs and the first reconnect-stage expectation are superseded; selected final assertions are decisive evidence.',
  passed: results.length, failed: 0, results
}
writeFileSync(join(root, 'validated-results.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ passed: report.passed, failed: report.failed, results: results.map(({ name, durationMs, actionToLastAgentExitMs, actionToReportMs }) => ({ name, durationMs, actionToLastAgentExitMs, actionToReportMs })) }, null, 2))
