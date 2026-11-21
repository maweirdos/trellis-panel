import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { clipUtf8, IMPLICIT_MATERIAL_BUDGET_BYTES, utf8ByteLength } from '../../shared/material-budget'
import { agentRulesManifestSchema, MAX_AGENT_RULE_SOURCES, teamTaskRulesContextSchema, type AgentRulesManifest, type TeamTaskRulesManifest } from '../../shared/agent-rules'
import { readDocument } from './documents/controller'
import { resolveAuthorizedDocumentPath } from './documents/paths'
import { taskDirSchema } from './acp/types'
import { assertNoUnownedTeamTaskRules, MAX_TASK_RULE_BYTES, readTaskInputRules, readExecutionInputRules, type FixedTaskRule, type FixedExecutionRules } from './crux/task-input-rules'
import { executionContextManifestSchema, executionContextPacketSchema, type ExecutionContextManifest, type ExecutionInputSource } from '../../shared/team-execution-input'
import { executionContextEnvelopeBytes, FIXED_EXECUTION_CONTEXT_MIME } from './execution-context-budget'

const digest = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex')
const MAX_RULE_BYTES = MAX_TASK_RULE_BYTES
const MAX_RULES = MAX_AGENT_RULE_SOURCES
export { agentRuleEntrySchema, agentRulesManifestSchema, type AgentRulesManifest } from '../../shared/agent-rules'
const additionalRuleSchema = z.object({
  id: z.string().min(1).max(256), version: z.string().min(1).max(256),
  title: z.string().min(1).max(300), body: z.string().max(MAX_RULE_BYTES)
}).strict()
const prepareSchema = z.object({
  projectRoot: z.string().min(1).max(8192), taskDir: taskDirSchema.optional(),
  additionalRules: z.array(additionalRuleSchema).max(12).default([]),
  teamTask: teamTaskRulesContextSchema.optional()
}).strict()
export type PrepareAgentRulesInput = z.input<typeof prepareSchema>
export type PreparedAgentRules = { instructions: string; manifest: AgentRulesManifest }
export type PrepareExecutionAgentRulesInput = { executionSource: ExecutionInputSource; nodeId: string }
export type PreparedExecutionAgentRules = { instructions: string; manifest: ExecutionContextManifest; assertCurrent(): Promise<void> }
const completeExecutionRules = new WeakMap<PreparedExecutionAgentRules, { instructions: string; manifest: string; assertCurrent(): Promise<void> }>()
type Rule = { path: string; source: 'project' | 'team'; body: string | null; totalBytes: number; declaredVersion?: string; indexOnly?: boolean; required?: boolean; fixed?: FixedTaskRule }
const manifestLineSchema = z.object({ file: z.string().min(1).max(2048), type: z.string().optional() }).passthrough()
const rootKey = (root: string): string => digest(process.platform === 'win32' ? root.toLowerCase() : root)

function canonicalRoot(root: string): string {
  if (!isAbsolute(root)) throw new Error('Agent rules require an absolute project root')
  const physical = realpathSync.native(root)
  if (!statSync(physical).isDirectory()) throw new Error('Agent rules project root is not a directory')
  return physical
}

/** Reuse the document reader's stable-read and physical-root boundary. */
async function projectRule(root: string, path: string, required = false): Promise<Rule | null> {
  const authorized = resolveAuthorizedDocumentPath(root, path)
  if (!authorized.ok) throw new Error('Agent rule path is outside its bound project')
  if (!authorized.exists) {
    if (required) throw new Error(`Selected Agent rule is missing: ${path}`)
    return null
  }
  const info = statSync(authorized.canonicalPath)
  if (!info.isFile()) throw new Error(`Agent rule is not a file: ${path}`)
  if (info.size > MAX_RULE_BYTES) return { path, source: 'project', body: null, totalBytes: info.size }
  const result = await readDocument(root, { workspaceId: root }, { relativePath: path, requestId: 'agent-rule-context' })
  if (!result.ok || result.rawText === null) throw new Error(`Agent rule cannot be read: ${path}`)
  if (utf8ByteLength(result.rawText) > MAX_RULE_BYTES) throw new Error(`Agent rule changed while reading: ${path}`)
  return { path, source: 'project', body: result.rawText, totalBytes: utf8ByteLength(result.rawText) }
}

async function selectedPaths(root: string, taskDir?: string): Promise<{ paths: string[]; manifests: Rule[] }> {
  const selected = new Set<string>()
  const manifests: Rule[] = []
  if (!taskDir) return { paths: [], manifests }
  for (const name of ['implement.jsonl', 'check.jsonl']) {
    const path = `.trellis/tasks/${taskDir}/${name}`
    const manifest = await projectRule(root, path)
    if (!manifest) continue
    if (manifest.body === null) throw new Error(`Agent rule selection exceeds its size limit: ${path}`)
    manifests.push({ ...manifest, indexOnly: true })
    for (const line of manifest.body.split(/\r?\n/)) {
      if (!line.trim()) continue
      const entry = manifestLineSchema.parse(JSON.parse(line))
      const file = entry.file.replace(/\\/g, '/')
      if (entry.type && entry.type !== 'file') continue
      if (isAbsolute(file) || file.split('/').some(part => part === '..' || part === '.' || !part)) throw new Error('Invalid selected Agent rule path')
      if (!file.startsWith('.trellis/spec/') || !file.toLowerCase().endsWith('.md')) continue
      selected.add(file)
      if (selected.size > MAX_RULES - 5) throw new Error('Too many selected Agent rules; narrow the task context')
    }
  }
  return { paths: [...selected], manifests }
}

/** Bounded, versioned rules for both ordinary and explicitly task-bound sessions. */
export function prepareAgentRules(raw: PrepareAgentRulesInput): Promise<PreparedAgentRules>
export function prepareAgentRules(raw: PrepareExecutionAgentRulesInput): Promise<PreparedExecutionAgentRules>
export async function prepareAgentRules(raw: PrepareAgentRulesInput | PrepareExecutionAgentRulesInput): Promise<PreparedAgentRules | PreparedExecutionAgentRules> {
  if ('executionSource' in raw) return prepareExecutionAgentRules(raw)
  const input = prepareSchema.parse(raw)
  const root = canonicalRoot(input.projectRoot)
  const fixed = input.teamTask && input.taskDir ? await readTaskInputRules({ projectRoot: root, taskDir: input.taskDir, teamTask: input.teamTask }) : undefined
  if (!input.teamTask) assertNoUnownedTeamTaskRules(root, input.taskDir)
  // A bound task's short identity/authority instructions must precede discovery indexes.
  const rules: Rule[] = input.additionalRules.map(rule => ({
    path: `team:${rule.id}`, source: 'team', body: rule.body,
    totalBytes: utf8ByteLength(rule.body), declaredVersion: rule.version, required: Boolean(fixed)
  }))
  const orderedTeamRules = [...fixed?.rules ?? []].sort((a, b) => Number(b.required) - Number(a.required)
    || (b.version.settings.kind === 'rule' ? b.version.settings.priority : 1001) - (a.version.settings.kind === 'rule' ? a.version.settings.priority : 1001)
    || a.path.localeCompare(b.path))
  const teamRule = (rule: FixedTaskRule): Rule => ({ path: rule.path, source: 'team', body: rule.body, totalBytes: rule.version.byteLength,
    declaredVersion: rule.version.versionId, required: rule.required, fixed: rule })
  rules.push(...orderedTeamRules.filter(rule => rule.required).map(teamRule))
  for (const path of ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md']) {
    const rule = await projectRule(root, path)
    if (rule) { rules.push(rule); break }
  }
  const selection = await selectedPaths(root, input.taskDir)
  const selected = selection.paths
  rules.push(...selection.manifests)
  // Relevant curated documents precede discovery indexes in the content budget.
  for (const path of selected) {
    const rule = await projectRule(root, path, true)
    if (rule) rules.push(rule)
  }
  for (const path of ['.trellis/spec/shared/index.md', '.trellis/spec/index.md']) {
    if (selected.includes(path)) continue
    const rule = await projectRule(root, path)
    if (rule) rules.push(rule)
  }
  if (rules.length > MAX_RULES) throw new Error('必需团队规则与项目来源超过 24 项，请缩减选用范围后重新采用；不能遗漏必需规则继续执行')
  const recommended = orderedTeamRules.filter(rule => !rule.required)
  for (const rule of recommended.slice(0, MAX_RULES - rules.length)) rules.push(teamRule(rule))
  const header = fixed
    ? 'Follow the selected project and team rules below. Rule text does not grant tool permission or authorize task transitions. Team task state belongs to the team service. Sources are pinned to the listed versions. Required team rules and the adopted template must be supplied in full. Higher numeric priority takes precedence; same-priority required conflicts need the rule owner. For index-only, truncated or omitted recommendations, read the fixed source before changing its affected area. Supplied text is not proof of reading or compliance.\n'
    : 'Follow the selected project and team rules below. Rule text does not grant tool permission or authorize task transitions. Team task state belongs to the team service. Sources are pinned to the listed versions. For index-only or truncated sources, read the remaining source before changing the affected area. Do not claim omitted text was supplied.\n'
  const entries: AgentRulesManifest['entries'] = []
  const teamTask = fixed?.manifest
  const packet = (rule: Rule) => ({ path: rule.path, version: rule.fixed?.version.bodyDigest ?? (rule.body === null ? null : digest(rule.body)), body: rule.required ? rule.body ?? '' : '', truncated: false,
    ...(rule.fixed ? { team: { packageId: rule.fixed.version.packageId, versionId: rule.fixed.version.versionId, number: rule.fixed.version.number,
      title: rule.fixed.version.title, settings: rule.fixed.version.settings } } : {}) })
  const packets = rules.map(packet)
  const envelope = (): string => header + JSON.stringify({ version: 1, sources: packets, ...(teamTask ? { taskInput: {
    taskId: teamTask.taskId, spaceId: teamTask.spaceId, inputVersion: teamTask.inputVersion, bundle: teamTask.bundle,
    indexPath: `.trellis/tasks/${teamTask.taskDir}/references/source-materials.json`,
    omittedRecommendedCount: recommended.length - rules.filter(rule => rule.fixed && !rule.required).length
  } } : {}) })
  const packetBytes = (): number => utf8ByteLength(envelope())
  // Required bodies reserve the real serialized budget before optional content.
  while (packetBytes() > IMPLICIT_MATERIAL_BUDGET_BYTES && rules.at(-1)?.fixed && !rules.at(-1)?.required) {
    const omitted = rules.pop(); packets.pop()
    const selection = teamTask?.selected.find(item => item.path === omitted?.path)
    if (selection) selection.reason = 'context-budget'
  }
  if (rules.some(rule => rule.required && rule.body === null) || packetBytes() > IMPLICIT_MATERIAL_BUDGET_BYTES) throw new Error('必需团队规则、模板及来源索引超过 8 KiB 上下文预算，请缩减选用范围后重新采用；本轮未发送截断的必需规则')
  for (const [index, rule] of rules.entries()) {
    const available = Math.max(0, IMPLICIT_MATERIAL_BUDGET_BYTES - packetBytes())
    let included = rule.required ? rule.body ?? '' : rule.body === null || rule.indexOnly ? '' : clipUtf8(rule.body, available)
    // Budget the serialized string, including escaped quotes and line breaks.
    while (!rule.required && utf8ByteLength(JSON.stringify(included)) - 2 > available) {
      const excess = utf8ByteLength(JSON.stringify(included)) - 2 - available
      included = clipUtf8(included, Math.max(0, utf8ByteLength(included) - excess))
    }
    const includedBytes = utf8ByteLength(included)
    const version = rule.fixed?.version.bodyDigest ?? (rule.body === null ? null : digest(rule.body))
    const truncated = rule.body === null || Boolean(rule.indexOnly) || includedBytes < rule.totalBytes
    entries.push({ path: rule.path, source: rule.source, version,
      ...(rule.declaredVersion ? { declaredVersion: rule.declaredVersion } : {}),
      includedDigest: includedBytes ? digest(included) : null, includedBytes, includedChars: included.length,
      totalBytes: rule.totalBytes, truncated, status: includedBytes ? 'included' : 'index-only' })
    packets[index] = { ...packets[index], path: rule.path, version, body: included, truncated }
    const selection = teamTask?.selected.find(item => item.path === rule.path)
    if (selection) {
      selection.status = includedBytes ? truncated ? 'partial' : 'included' : 'index-only'
      selection.reason = truncated ? rule.body === null ? 'byte-limit' : 'context-budget' : undefined
    }
  }
  const manifest = agentRulesManifestSchema.parse({ version: 1, projectRootKey: rootKey(root), entries, ...(teamTask ? { teamTask } : {}), digest: manifestDigest(entries, teamTask) })
  const instructions = rules.length || teamTask ? envelope() : ''
  // JSON escaping can increase the final envelope beyond the raw source budget.
  if (utf8ByteLength(instructions) > IMPLICIT_MATERIAL_BUDGET_BYTES) throw new Error('Serialized Agent rules exceed their context budget; narrow the selected rules')
  return { instructions, manifest }
}

/** Same rule owner, additive fixed-source path; legacy packets/hashes stay byte-identical. */
export async function prepareExecutionAgentRules(raw: PrepareExecutionAgentRulesInput): Promise<PreparedExecutionAgentRules> {
  const fixed = await readExecutionInputRules(raw.executionSource, raw.nodeId)
  const prepared = await composeFixedExecutionAgentRules(fixed)
  completeExecutionRules.set(prepared, { instructions: prepared.instructions, manifest: JSON.stringify(prepared.manifest), assertCurrent: fixed.assertCurrent })
  return prepared
}

/** Only a complete original-node preparation can authorize the legacy prompt path. */
export async function assertCompleteExecutionAgentRules(prepared: PreparedExecutionAgentRules): Promise<void> {
  const original = completeExecutionRules.get(prepared)
  if (!original || prepared.instructions !== original.instructions || JSON.stringify(prepared.manifest) !== original.manifest) throw new Error('A partitioned or modified execution context requires its original atomic aggregate')
  await original.assertCurrent()
}

/** Shared accounting implementation; a partitioned result is usable only in its aggregate. */
export async function composeFixedExecutionAgentRules(fixed: FixedExecutionRules): Promise<PreparedExecutionAgentRules> {
  const { input } = fixed.view
  const role = input.definition.roles.find(item => item.id === fixed.node.roleId)
  if (!role) throw new Error('Fixed node has no logical role instructions')
  type Source = z.infer<typeof executionContextPacketSchema>['sources'][number]
  const sources: Source[] = fixed.rules.map(rule => {
    const selection = rule.resource.selection, required = selection.required
    const status = rule.status !== 'available' || rule.body === null ? 'unavailable' : required ? 'full' : selection.delivery === 'omitted' ? 'omitted' : 'index-only'
    const text = required ? rule.body : null
    return { selection, sourceDigest: rule.resource.bodyDigest, sourceBytes: rule.resource.byteLength,
      deliveredDigest: text === null ? null : digest(text), deliveredBytes: text === null ? 0 : utf8ByteLength(text), deliveredChars: text?.length ?? 0,
      status, reason: rule.status === 'withdrawn' ? 'withdrawn' : status === 'unavailable' ? 'unavailable' : !required && (selection.delivery === 'full' || selection.delivery === 'partial') ? 'context-budget' : 'selected', text }
  })
  const packet = { contractVersion: 2 as const, inputDigest: input.digest, executionId: input.executionId, node: fixed.node, roleInstructions: role.instructions, sources }
  const serialize = (): string => JSON.stringify(packet)
  const envelopeBytes = (text: string): { acp: number; pi: number } => executionContextEnvelopeBytes({ uri: `trellis://execution-input/${input.executionId}/${encodeURIComponent(fixed.node.id)}/${digest(text)}`, mimeType: FIXED_EXECUTION_CONTEXT_MIME, text })
  const size = (): number => { const text = serialize(), bytes = envelopeBytes(text); return Math.max(utf8ByteLength(text), bytes.acp, bytes.pi) }
  if (size() > IMPLICIT_MATERIAL_BUDGET_BYTES) throw new Error('Required fixed inputs and source receipts exceed the serialized 8 KiB context budget')
  const provide = (index: number, text: string, status: 'full' | 'partial'): void => {
    sources[index] = { ...sources[index], text, status, reason: status === 'full' ? 'selected' : 'context-budget', deliveredDigest: digest(text), deliveredBytes: utf8ByteLength(text), deliveredChars: text.length }
  }
  for (const [index, rule] of fixed.rules.entries()) {
    const selection = rule.resource.selection
    if (selection.required || rule.status !== 'available' || rule.body === null || ['index-only', 'omitted'].includes(selection.delivery)) continue
    const initial = sources[index]
    provide(index, rule.body, 'full')
    if (size() <= IMPLICIT_MATERIAL_BUDGET_BYTES) continue
    sources[index] = { ...initial, reason: 'context-budget' }
    if (selection.delivery === 'full') continue
    let low = 0, high = Math.min(utf8ByteLength(rule.body), IMPLICIT_MATERIAL_BUDGET_BYTES), best = ''
    while (low <= high) {
      const middle = Math.floor((low + high) / 2), text = clipUtf8(rule.body, middle)
      provide(index, text, 'partial')
      if (size() <= IMPLICIT_MATERIAL_BUDGET_BYTES) { best = text; low = middle + 1 } else high = middle - 1
    }
    if (best) provide(index, best, 'partial')
    else sources[index] = { ...initial, reason: 'context-budget' }
  }
  const instructions = JSON.stringify(executionContextPacketSchema.parse(packet))
  const manifest = executionContextManifestSchema.parse({ contractVersion: 2, state: 'prepared', inputDigest: input.digest,
    nodeId: fixed.node.id, phaseId: fixed.node.phaseId, stage: fixed.node.stage,
    instructionDigest: digest(JSON.stringify({ roleInstructions: role.instructions, node: fixed.node })), instructionBytes: utf8ByteLength(JSON.stringify({ roleInstructions: role.instructions, node: fixed.node })),
    entries: sources.map(({ text: _text, ...receipt }) => receipt), serializedBytes: utf8ByteLength(instructions), envelopeBytes: envelopeBytes(instructions), packetDigest: digest(instructions) })
  await fixed.assertCurrent()
  return { instructions, manifest, assertCurrent: fixed.assertCurrent }
}

function manifestDigest(entries: AgentRulesManifest['entries'], teamTask?: TeamTaskRulesManifest): string {
  // Preserve legacy version-1 hashes when the additive native-team context is absent.
  return digest(JSON.stringify(teamTask ? { entries, teamTask } : entries))
}

/** A changed rule needs explicit re-adoption; this check never replaces live context. */
export async function assertAgentRulesCurrent(projectRoot: string, raw: AgentRulesManifest): Promise<void> {
  const manifest = agentRulesManifestSchema.parse(raw)
  const root = canonicalRoot(projectRoot)
  if (manifest.projectRootKey !== rootKey(root) || manifest.digest !== manifestDigest(manifest.entries, manifest.teamTask)) throw new Error('Agent rules belong to another project or were modified')
  if (manifest.teamTask) {
    const { taskId, spaceId, inputVersion, workcopyTaskKey, taskDir } = manifest.teamTask
    const fixed = await readTaskInputRules({ projectRoot: root, taskDir, teamTask: { taskId, spaceId, inputVersion, ...(workcopyTaskKey ? { workcopyTaskKey } : {}) } })
    const identity = (task: TeamTaskRulesManifest): string => JSON.stringify({ ...task, selected: task.selected.map(({ path, version }) => ({ path, version })) })
    if (identity(fixed.manifest) !== identity(manifest.teamTask)) throw new Error('原任务规则包、创建身份或开发尝试已变化，请显式建立新会话采用')
  }
  for (const entry of manifest.entries) {
    if (entry.source !== 'project') continue
    const actual = await projectRule(root, entry.path, true)
    if (!actual || actual.totalBytes !== entry.totalBytes || (entry.version !== null && (actual.body === null || digest(actual.body) !== entry.version))) throw new Error(`Agent rule version changed; explicitly refresh the session context: ${entry.path}`)
  }
}
