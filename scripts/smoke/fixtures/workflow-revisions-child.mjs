/** Owned actual process-exit checkpoint; no native model or company data. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { harness, until } from './workflow-revisions-harness.mjs'
const [root, bundle, marker, checkpoint = 'reservation'] = process.argv.slice(2)
const api = await import(pathToFileURL(bundle).href)
const h = await harness(api, root, { root, blocked: true })
const admission = await h.start()
await until(() => h.fake.prompts.length === 1, 'child admitted native fixture turn')
const preview = await h.preview(admission.run)
const commandId = checkpoint === 'commit' ? 'exit-commit' : 'exit-reservation'
await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, commandId, previewId: preview.previewId })
writeFileSync(join(root, 'actual-child-side-effect.txt'), 'Owned child wrote this before exit; never replay by assumption.')
const report = { target: admission.run, previewId: preview.previewId, origin: admission.scope, pid: process.pid, commandId, checkpoint }
if (checkpoint === 'commit') {
  const commit = h.app.control.commitWithManifests.bind(h.app.control)
  h.app.control.commitWithManifests = async (request) => {
    const result = await commit(request)
    if (request.journal.command.commandId === commandId) { writeFileSync(marker, JSON.stringify(report)); process.exit(0) }
    return result
  }
  h.fake.release()
  await new Promise(() => {})
}
writeFileSync(marker, JSON.stringify(report))
process.exit(0)
