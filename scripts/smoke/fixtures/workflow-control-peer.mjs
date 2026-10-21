import { DatabaseSync } from 'node:sqlite'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startInput, adoptionInput, scope } from './workflow-control-data.mjs'

const [mode, bundle, directory, argument] = process.argv.slice(2)
const api = await import(pathToFileURL(bundle).href)
if (mode === 'lock') {
  const db = new DatabaseSync(join(directory, 'control.sqlite'))
  db.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE;')
  process.send?.({ kind: 'locked' })
  setTimeout(() => { db.exec('COMMIT'); db.close(); process.exit(0) }, Number(argument ?? 700))
} else if (mode === 'crash') {
  let armed = false
  const core = new api.WorkflowControlCore(directory, { onTransactionStage(stage) { if (armed && stage === argument) process.exit(stage === 'before-commit' ? 76 : 77) } })
  core.open()
  const claimed = core.claimWorkspace({ scope, ownerId: 'crash-owner', ttlMs: 30_000 })
  const input = startInput(api, claimed.lease.owner)
  armed = true
  await core.commitWithManifests(input)
  throw new Error('Crash hook did not execute')
} else if (mode === 'side-effect') {
  const core = new api.WorkflowControlCore(directory); core.open()
  const claimed = core.claimWorkspace({ scope, ownerId: 'effect-owner', ttlMs: 30_000 })
  await core.commitWithManifests(startInput(api, claimed.lease.owner))
  core.claimOperation({ scope, owner: claimed.lease.owner, operationId: 'operation-a' })
  writeFileSync(join(directory, 'actual-side-effect.txt'), 'performed-once', { flag: 'wx' })
  process.exit(78)
} else if (mode === 'race') {
  const [name, kind, barrier] = argument.split('|')
  const core = new api.WorkflowControlCore(directory); core.open()
  process.send?.({ kind: 'ready' })
  const deadline = Date.now() + 10_000
  while (!existsSync(barrier)) {
    if (Date.now() > deadline) throw new Error('Race barrier timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const lease = core.claimWorkspace({ scope, ownerId: name, ttlMs: 30_000 })
  let result = { status: 'owner-conflict' }
  if (lease.status !== 'owner-conflict') result = await core.commitWithManifests(kind === 'adopt' ? adoptionInput(api, lease.lease.owner, name) : startInput(api, lease.lease.owner))
  process.send?.({ kind: 'result', result })
  await new Promise((resolve) => setTimeout(resolve, 250))
  core.close()
} else throw new Error('Unknown workflow control fixture mode')
