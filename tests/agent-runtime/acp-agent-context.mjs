/** Real facade/runtime and owned ACP peer; no native installation or model calls. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createFileSessionStore } from 'acpx/runtime'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

const directory = mkdtempSync(join(tmpdir(), 'trellis-agent-context-'))
const root = join(directory, 'project with spaces')
const outside = join(directory, 'outside')
mkdirSync(root); mkdirSync(outside)
process.env.TPAP_SMOKE_DIR = directory
process.env.TRELLIS_AGENT_CONTEXT_JOURNAL = join(directory, 'wire.jsonl')
if (!process.argv.includes('--trellis-role=daemon')) process.argv.push('--trellis-role=daemon')
const entry = '.agents/skills/project-evidence/SKILL.md'
const skillText = '---\nname: project-evidence\ndescription: Use when the user asks about project rules.\n---\nRead scoped project knowledge only when relevant.\n'
mkdirSync(join(root, '.agents/skills/project-evidence'), { recursive: true })
writeFileSync(join(root, entry), skillText)
writeFileSync(join(outside, 'SKILL.md'), skillText)
const journal = () => { try { return readFileSync(process.env.TRELLIS_AGENT_CONTEXT_JOURNAL, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) } catch { return [] } }
const prompts = () => journal().filter(call => call.method === 'session/prompt')
const pause = ms => new Promise(done => setTimeout(done, ms))
async function until(predicate, name) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await pause(10) }
  throw new Error(`Deadline: ${name}`)
}
let acp
try {
  await prepareAcpHistoryWorker(directory)
  await build({ stdin: { contents: "export * from './src/main/services/acp'; export {prepareAgentContext} from './src/main/services/acp/agent-context'; export {upgradeLegacyKnowledgePolicy} from './src/main/services/acp/legacy-knowledge-policy'; export {setSettings} from './src/main/services/store';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: join(directory, 'service.mjs'),
    banner: { js: "import {createRequire as fixtureRequire} from 'node:module'; const require=fixtureRequire(import.meta.url);" },
    alias: { electron: resolve('tests/agent-runtime/mock-electron.mjs') } })
  acp = await import(pathToFileURL(join(directory, 'service.mjs')).href)
  acp.setSettings({ acp: { nodePath: process.execPath, agents: ['context', 'no-context'].map(id => ({ id, name: id, enabled: true,
    command: 'owned context peer', launchKind: 'custom', executable: process.execPath,
    args: [resolve('tests/agent-runtime/fixtures/acp-agent-context-peer.mjs'), ...(id === 'no-context' ? ['--no-context'] : [])] })) } })
  const profile = { id: 'role', name: 'Evidence role', description: 'Controlled role', instructions: 'ROLE-NONCE: answer in the selected review format.',
    skillPaths: [entry], runtimeId: 'context', maxTurnMinutes: 1 }
  assert.equal(acp.saveAcpProfile(root, profile).ok, true)
  assert.deepEqual(acp.listAcpProfiles(root).profiles.find(value => value.id === profile.id).skillPaths, [entry])
  const prepared = acp.prepareAgentContext(root, 'session', profile)
  assert.ok(prepared.resource.text.includes(profile.instructions))
  assert.ok(prepared.resource.text.includes('Use when the user asks about project rules.'))
  assert.ok(!prepared.resource.text.includes('Read scoped project knowledge only when relevant.'), 'Only the manifest is delivered; body loads on demand')
  prepared.assertCurrent()
  writeFileSync(join(root, entry), skillText + 'Changed\n')
  assert.throws(() => prepared.assertCurrent(), /技能已改变/)
  writeFileSync(join(root, entry), skillText)
  for (const path of ['../outside/SKILL.md', 'C:/outside/SKILL.md', '/outside/SKILL.md', '.agents/skills/missing/SKILL.md', '.agents/skills/project-evidence/../SKILL.md']) {
    assert.equal(acp.saveAcpProfile(root, { ...profile, skillPaths: [path] }).ok, false, path)
  }
  assert.equal(acp.saveAcpProfile(root, { ...profile, skillPaths: [entry, entry] }).ok, false)
  const link = join(root, '.agents/skills/escape')
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(acp.saveAcpProfile(root, { ...profile, skillPaths: ['.agents/skills/escape/SKILL.md'] }).ok, false)
  const bad = join(root, '.agents/skills/bad')
  mkdirSync(bad)
  for (const bytes of ['---\nname: missing-description\n---\n', 'x'.repeat(128 * 1024 + 1), Buffer.from([0xff, 0xfe, 0x80])]) {
    writeFileSync(join(bad, 'SKILL.md'), bytes)
    assert.equal(acp.saveAcpProfile(root, { ...profile, skillPaths: ['.agents/skills/bad/SKILL.md'] }).ok, false)
  }
  console.log('PASS profile persistence, manifest-only context, revision drift, path/junction/UTF-8/metadata/size bounds')

  const created = await acp.newAcpSession(root, { agentId: 'context', profileId: profile.id })
  assert.equal(created.ok, true)
  let id = created.sessionId
  const current = () => acp.listAcpSessions(root).sessions.find(session => session.sessionId === id)
  await until(() => current()?.status === 'ready', 'actual session readiness')
  assert.equal(current().capabilities.promptCapabilities.embeddedContext, true)
  assert.equal(journal().find(call => call.method === 'session/new').params._meta?.systemPrompt, undefined, 'No ignored vendor systemPrompt metadata')
  async function turn(text) {
    const result = await acp.promptAcpSession(root, id, text)
    assert.equal(result.ok, true, result.error)
    await until(() => current()?.events.some(event => event.kind === 'turn-done' && event.turnId === result.turnId), 'actual terminal turn')
    await until(() => current()?.status === 'ready', 'retained ready connection')
    return result
  }
  const first = await turn('你好')
  const wire = prompts().at(-1).params.prompt
  assert.equal(wire[0].text, '你好')
  assert.equal(wire.length, 2)
  assert.equal(wire[1].type, 'resource')
  assert.ok(wire[1].resource.text.includes(profile.instructions))
  assert.equal(current().agentContext.state, 'sent')
  assert.equal(current().agentContext.turnId, first.turnId)
  assert.deepEqual(current().agentContext.skills.map(skill => skill.relativePath), [entry])
  assert.equal(current().events.find(event => event.kind === 'message' && event.payload?.role === 'user').text, '你好')
  const originalNative = current().backendSessionId
  assert.equal(acp.saveAcpProfile(root, { ...profile, instructions: 'NEW DEFAULT FOR FUTURE SESSIONS' }).ok, true)
  await turn('你是谁')
  assert.ok(prompts().at(-1).params.prompt[1].resource.text.includes(profile.instructions), 'Current session retains its role snapshot')
  assert.ok(!prompts().at(-1).params.prompt[1].resource.text.includes('NEW DEFAULT'))
  await turn('/help')
  assert.deepEqual(prompts().at(-1).params.prompt, [{ type: 'text', text: '/help' }], 'Native command stays untouched')
  const beforeInvalid = prompts().length
  writeFileSync(join(root, entry), '---\nname: broken\n---\n')
  assert.equal((await acp.promptAcpSession(root, id, 'invalid selected skill')).ok, false)
  assert.equal(prompts().length, beforeInvalid)
  assert.equal(current().status, 'ready')
  writeFileSync(join(root, entry), skillText)
  const held = await acp.promptAcpSession(root, id, 'hold')
  assert.equal(held.ok, true)
  assert.equal((await acp.cancelAcpSession(root, id)).ok, true)
  await until(() => current()?.status === 'ready', 'cancel retains healthy owner')
  await turn('next after cancel')
  assert.equal(current().backendSessionId, originalNative)
  assert.equal(journal().filter(call => call.method === 'session/new').length, 1)
  const runtimeStore = createFileSessionStore({ stateDir: join(directory, 'acp/runtime-store') })
  const recordId = current().acpxRecordId ?? id
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  const historical = await runtimeStore.load(recordId)
  const userOwned = { ...historical, acpx: { ...historical.acpx, session_options: { system_prompt: { append: 'User-owned custom instructions' } } } }
  assert.strictEqual(acp.upgradeLegacyKnowledgePolicy(userOwned, profile.instructions), userOwned)
  const plainPrompt = { ...historical, acpx: { ...historical.acpx, session_options: { system_prompt: 'User-owned base prompt' } } }
  assert.strictEqual(acp.upgradeLegacyKnowledgePolicy(plainPrompt), plainPrompt)
  historical.acpx.session_options = { ...historical.acpx.session_options, system_prompt: { append: profile.instructions + '\n\nProject knowledge and requirements workflow:\nFor text questions with selected project libraries, the host performs a bounded first lookup before this native turn.\nLegacy built-in policy.' } }
  await runtimeStore.save(historical)
  assert.equal((await acp.resumeAcpSession(root, id)).ok, true)
  await until(() => current()?.status === 'ready', 'same-session actual restore')
  assert.equal(current().backendSessionId, originalNative)
  assert.equal(current().agentContext, undefined, 'A new connection cannot inherit a historical delivery claim')
  const restoredPolicy = journal().findLast(call => call.method === 'session/load').params._meta.systemPrompt.append
  assert.ok(restoredPolicy.startsWith(profile.instructions))
  assert.ok(!restoredPolicy.includes('host performs a bounded first lookup'))
  assert.ok(restoredPolicy.includes('host does not search before dispatch'))
  await turn('after restore')
  assert.equal(current().agentContext.state, 'sent')
  assert.ok(prompts().at(-1).params.prompt[1].resource.text.includes(profile.instructions))
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  console.log('PASS unchanged question + separate role resource, native command, frozen role, invalid-source zero dispatch, cancel/next turn and same-session restore')

  assert.equal(acp.saveAcpProfile(root, { ...profile, id: 'unsupported', runtimeId: 'no-context' }).ok, true)
  const unsupported = await acp.newAcpSession(root, { agentId: 'no-context', profileId: 'unsupported' })
  assert.equal(unsupported.ok, true); id = unsupported.sessionId
  await until(() => current()?.status === 'ready', 'unsupported-context ordinary connection')
  const before = prompts().length
  const refused = await acp.promptAcpSession(root, id, '你好')
  assert.equal(refused.ok, false)
  assert.match(refused.error, /角色上下文附件/)
  assert.equal(prompts().length, before)
  assert.equal(current().status, 'ready')
  assert.equal((await acp.killAcpSession(root, id)).ok, true)
  const ordinary = await acp.newAcpSession(root, { agentId: 'no-context' })
  assert.equal(ordinary.ok, true); id = ordinary.sessionId
  await until(() => current()?.status === 'ready', 'unconfigured context does not require capability')
  await turn('plain original input')
  assert.deepEqual(prompts().at(-1).params.prompt, [{ type: 'text', text: 'plain original input' }])
  console.log('PASS unsupported configured context rejects before write; unconfigured ordinary dialogue stays usable')
} finally {
  await acp?.shutdownAcp()
  assert.ok(directory.startsWith(join(tmpdir(), 'trellis-agent-context-')))
  rmSync(directory, { recursive: true, force: true })
}
