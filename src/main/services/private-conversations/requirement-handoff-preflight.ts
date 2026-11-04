import { extname } from 'node:path'
import { TEXT_EXTS } from '../scan'
import { workflowContextBytes, type WorkflowPacketEntry } from '../workflow-runtime/context'
import { REQUIREMENT_REPORT_JSON_BYTES, requirementContextInstruction, requirementStageFile } from '../workflow-application/requirement-flow'
import type { RequirementHandoffPreflight, RequirementHandoffPreflightProof } from './requirements'
import { directoryIdentity, hash, readRegular } from './files'
import { readOptional, utf8 } from './requirement-files'
import { requirementDesignEvidenceSchema } from '../../../shared/conversation-requirements'
import { requirementConfirmedSchema, requirementPlanSchema } from '../../../shared/conversation-requirements'
import { z } from 'zod'
import { assertRequirementHandoffGrants } from './requirement-handoff-grants'

const BUDGET = 1024 * 1024
const DUMMY = 'f'.repeat(64)
const FIXED = 'Fixed requirement handoff: '

/** Conservative packet bound for the fixed default workflow, before task creation. */
export async function preflightRequirementHandoff(input: RequirementHandoffPreflight, current: () => void, extraMaterials: Array<{ path: string; text: string; kind: 'spec' | 'design' | 'other'; purpose: 'spec' | 'baseline'; reason: string }> = []): Promise<RequirementHandoffPreflightProof> {
  const assertTarget = (): void => {
    current()
    if (directoryIdentity(input.targetRoot) !== input.targetIdentity) throw new Error('预算预检期间目标工程身份已变化')
  }
  assertTarget()
  const prefix = `.trellis/tasks/${input.taskDir}/`
  const manifest = JSON.parse(input.manifest) as { references?: Array<{ path: string; revision: string; bytes: number }>; designEvidence?: unknown[] }
  assertRequirementHandoffGrants(manifest)
  if (!Array.isArray(manifest.references) || manifest.references.length !== input.references.length) throw new Error('预算预检的固定文件清单不一致')
  const entries: WorkflowPacketEntry[] = []
  const add = (path: string, text: string, kind: WorkflowPacketEntry['material']['kind'], reason: string, purpose = 'baseline', version = DUMMY): void => {
    entries.push({ ref: `wm-${DUMMY}`, material: { materialId: `material-${'f'.repeat(40)}`, version, kind, source: { kind: 'trellis-file', relativePath: path }, sourceDigest: DUMMY }, purpose, reason, inclusion: 'full', text })
  }
  // Task identity resolution refuses task.json above 256 KiB. JSON-string framing
  // can at most double its valid UTF-8 bytes, so this reserves that worst case.
  add(prefix + 'task.json', '\\'.repeat(256 * 1024), 'other', FIXED + 'task.json')
  add(prefix + 'references/conversation-requirement.json', input.manifest, 'other', FIXED + 'references/conversation-requirement.json')
  add(prefix + 'references/requirement.md', input.requirement, 'trellis-prd', FIXED + 'references/requirement.md')
  add(prefix + 'references/plan.md', input.plan.body, 'other', FIXED + 'references/plan.md')
  const confirmation = readRegular(input.conversationRoot, input.confirmed.relativePath, 2 * 1024 * 1024).bytes
  if (hash(confirmation) !== input.confirmed.snapshotRevision) throw new Error('预算预检的确认快照已变化')
  add(prefix + 'references/requirement-confirmation.json', utf8(confirmation), 'other', FIXED + 'references/requirement-confirmation.json')
  add(prefix + 'plan.md', input.plan.body, 'other', FIXED + 'plan.md')
  add(prefix + 'prd.md', input.requirement, 'trellis-prd', FIXED + 'prd.md')
  const workflow = readRegular(input.targetRoot, '.trellis/workflow.md', 1024 * 1024).bytes
  add('.trellis/workflow.md', utf8(workflow), 'spec', 'Task-selected engineering guideline', 'spec')
  const agents = readOptional(input.targetRoot, 'AGENTS.md', 1024 * 1024)?.bytes
  if (agents) add('AGENTS.md', utf8(agents), 'spec', 'Task-selected engineering guideline', 'spec')
  for (let index = 0; index < input.references.length; index++) {
    const reference = input.references[index], selected = manifest.references[index]
    const path = `references/requirement-files/${index}${extname(reference.snapshotPath)}`
    if (!selected || selected.path !== path || selected.revision !== reference.revision || selected.bytes !== reference.bytes) throw new Error('预算预检的文件版本与清单不一致')
    const bytes = readRegular(input.conversationRoot, reference.snapshotPath, 16 * 1024 * 1024).bytes
    if (bytes.length !== reference.bytes || hash(bytes) !== reference.revision) throw new Error('预算预检的文件快照已变化')
    let text: string | undefined
    if (TEXT_EXTS.has(extname(path).toLowerCase())) { try { text = utf8(bytes) } catch { /* Full binary encoding below. */ } }
    if (text !== undefined) add(prefix + path, text, 'other', FIXED + path)
    else {
      if (Math.ceil(bytes.length / 3) * 4 > BUDGET) return { inputDigest: hash(JSON.stringify(input)), workflowRevision: hash(workflow), contextDigest: hash('oversized-binary:' + reference.revision), budgetBytes: BUDGET, promptBytes: BUDGET + 1, complete: true }
      const encoded = JSON.stringify({ encoding: 'base64', path, originalSha256: reference.revision, bytes: bytes.length, content: bytes.toString('base64') })
      add(prefix + path, encoded, 'other', FIXED + path + ' (complete base64 file)', 'baseline', `${DUMMY}-base64`)
    }
  }
  const designEvidence = (manifest.designEvidence ?? []).map(value => requirementDesignEvidenceSchema.parse(value))
  if (designEvidence.length !== input.designFiles.length) throw new Error('预算预检的设计文件授权与快照不一致')
  for (let index = 0; index < input.designFiles.length; index++) {
    const file = input.designFiles[index], selected = designEvidence[index]
    const suffix = extname(file.source.name).slice(1).toLowerCase(), path = `references/requirement-design/${index}.${/^[a-z0-9]{1,10}$/.test(suffix) ? suffix : 'bin'}`
    if (!selected || selected.path !== path || selected.originalPath !== file.relativePath || selected.revision !== file.source.revision || selected.bytes !== file.bytes || JSON.stringify(selected.source) !== JSON.stringify(file.source)) throw new Error('预算预检的设计文件版本与清单不一致')
    const bytes = readRegular(input.conversationRoot, file.snapshotPath, 16 * 1024 * 1024).bytes
    if (bytes.length !== file.bytes || hash(bytes) !== file.source.revision) throw new Error('预算预检的设计文件快照已变化')
    let text: string | undefined
    if (TEXT_EXTS.has(extname(path).toLowerCase())) { try { text = utf8(bytes) } catch { /* Full binary encoding below. */ } }
    if (text !== undefined) add(prefix + path, text, 'other', FIXED + path)
    else {
      if (Math.ceil(bytes.length / 3) * 4 > BUDGET) return { inputDigest: hash(JSON.stringify(input)), workflowRevision: hash(workflow), contextDigest: hash('oversized-design:' + file.source.revision), budgetBytes: BUDGET, promptBytes: BUDGET + 1, complete: true }
      const encoded = JSON.stringify({ encoding: 'base64', path, originalSha256: file.source.revision, bytes: bytes.length, content: bytes.toString('base64') })
      add(prefix + path, encoded, 'other', FIXED + path + ' (complete base64 file)', 'baseline', `${DUMMY}-base64`)
    }
  }
  for (const extra of extraMaterials) add(extra.path, extra.text, extra.kind, extra.reason, extra.purpose)
  if (entries.length + 2 > 64) throw new Error('完整上下文材料数量超过上限')
  // The next stage consumes the actual implementation report. Its runtime
  // validator enforces this JSON-encoded bound before admitting that stage.
  const output: WorkflowPacketEntry = { ref: `wm-${DUMMY}`, material: { materialId: `material-${'f'.repeat(40)}`, version: DUMMY, kind: 'other', source: { kind: 'trellis-file', relativePath: prefix + requirementStageFile('implement') }, sourceDigest: DUMMY }, purpose: 'baseline', reason: 'Actual checked output from the preceding preset stage', inclusion: 'full', text: '\\'.repeat((REQUIREMENT_REPORT_JSON_BYTES - 2) / 2) }
  const implement = requirementContextInstruction(input.taskDir, 'implement'), check = requirementContextInstruction(input.taskDir, 'check')
  const promptBytes = Math.max(workflowContextBytes(implement, entries, entries.length), workflowContextBytes(check, [...entries, output], entries.length + 1))
  const workflowRevision = hash(JSON.stringify([hash(workflow), agents ? hash(agents) : null, implement, check, REQUIREMENT_REPORT_JSON_BYTES]))
  const contextDigest = hash(JSON.stringify([entries.map(entry => [entry.material.source, hash(entry.text ?? '')]), promptBytes]))
  assertTarget()
  const latestWorkflow = readRegular(input.targetRoot, '.trellis/workflow.md', 1024 * 1024).bytes
  const latestAgents = readOptional(input.targetRoot, 'AGENTS.md', 1024 * 1024)?.bytes
  if (hash(latestWorkflow) !== hash(workflow) || (latestAgents ? hash(latestAgents) : null) !== (agents ? hash(agents) : null) || hash(readRegular(input.conversationRoot, input.confirmed.relativePath, 2 * 1024 * 1024).bytes) !== input.confirmed.snapshotRevision) throw new Error('预算预检期间目标规则或确认快照已变化')
  for (const reference of input.references) if (hash(readRegular(input.conversationRoot, reference.snapshotPath, 16 * 1024 * 1024).bytes) !== reference.revision) throw new Error('预算预检期间文件快照已变化')
  for (const file of input.designFiles) if (hash(readRegular(input.conversationRoot, file.snapshotPath, 16 * 1024 * 1024).bytes) !== file.source.revision) throw new Error('预算预检期间设计文件快照已变化')
  assertTarget()
  return { inputDigest: hash(JSON.stringify(input)), workflowRevision, contextDigest, budgetBytes: BUDGET, promptBytes, complete: true, designMaterials: designEvidence.map(({ path, revision, bytes }) => ({ path, revision, bytes })) }
}

/** Recheck actual target planning documents before activating an already-created task. */
export async function preflightReviewedHandoff(root: string, taskDir: string, taskId: string, review: { files: Array<{ path: string; text: string }> }, current: () => void): Promise<RequirementHandoffPreflightProof> {
  const prefix = `.trellis/tasks/${taskDir}/`, manifestText = utf8(readRegular(root, prefix + 'references/conversation-requirement.json', 64 * 1024).bytes)
  const manifest = z.object({ draftId: z.string().uuid(), draftRevision: z.string().uuid(), confirmed: requirementConfirmedSchema,
    plan: z.object({ revision: z.string().uuid(), bodyRevision: z.string(), sourceRevision: z.string().uuid(), sourceDigest: z.string() }).passthrough(),
    references: z.array(z.object({ fileId: z.string(), name: z.string(), originalPath: z.string(), path: z.string(), revision: z.string(), bytes: z.number() }).passthrough()),
    designEvidence: z.array(requirementDesignEvidenceSchema).max(16).default([]) }).passthrough().parse(JSON.parse(manifestText))
  const requirement = utf8(readRegular(root, prefix + 'prd.md', 256 * 1024).bytes), planBody = utf8(readRegular(root, prefix + 'plan.md', 256 * 1024).bytes)
  const plan = requirementPlanSchema.parse({ revision: manifest.plan.revision, bodyRevision: manifest.plan.bodyRevision, sourceRevision: manifest.plan.sourceRevision, sourceDigest: manifest.plan.sourceDigest, body: planBody, relativePath: 'plan.md', stale: false, updatedAt: 0 })
  const confirmed = { ...manifest.confirmed, relativePath: prefix + 'references/requirement-confirmation.json' }
  const references = manifest.references.map(item => ({ fileId: item.fileId, name: item.name, revision: item.revision, relativePath: item.originalPath, snapshotPath: prefix + item.path, bytes: item.bytes }))
  const designFiles = manifest.designEvidence.map(item => ({ source: item.source, relativePath: item.originalPath, snapshotPath: prefix + item.path, bytes: item.bytes }))
  const extras: Array<{ path: string; text: string; kind: 'spec' | 'design' | 'other'; purpose: 'spec' | 'baseline'; reason: string }> = []
  for (const file of review.files) {
    if (file.path === prefix + 'design.md' || file.path === prefix + 'implement.md') extras.push({ path: file.path, text: file.text, kind: file.path.endsWith('/design.md') ? 'design' : 'other', purpose: 'baseline', reason: FIXED + file.path.slice(prefix.length) })
    else if (file.path.startsWith('.trellis/spec/')) extras.push({ path: file.path, text: file.text, kind: 'spec', purpose: 'spec', reason: 'Task-selected engineering guideline' })
    else if (file.path.startsWith(prefix + 'research/')) extras.push({ path: file.path, text: file.text, kind: 'other', purpose: 'baseline', reason: FIXED + file.path })
  }
  const input: RequirementHandoffPreflight = { version: 1, targetRoot: root, targetIdentity: directoryIdentity(root), conversationRoot: root, draftId: manifest.draftId, draftRevision: manifest.draftRevision, commandId: manifest.confirmed.commandId, taskId, taskDir, requirement, plan, confirmed, manifest: manifestText, references, designFiles }
  return preflightRequirementHandoff(input, current, extras)
}
