import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { clipUtf8, IMPLICIT_MATERIAL_BUDGET_BYTES, utf8ByteLength } from '../../shared/material-budget'
import { agentRulesManifestSchema, MAX_AGENT_RULE_SOURCES, type AgentRulesManifest } from '../../shared/agent-rules'
import { readDocument } from './documents/controller'
import { resolveAuthorizedDocumentPath } from './documents/paths'
import { taskDirSchema } from './acp/types'

const digest = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex')
const MAX_RULE_BYTES = 128 * 1024
const MAX_RULES = MAX_AGENT_RULE_SOURCES
export { agentRuleEntrySchema, agentRulesManifestSchema, type AgentRulesManifest } from '../../shared/agent-rules'
const additionalRuleSchema = z.object({
  id: z.string().min(1).max(256), version: z.string().min(1).max(256),
  title: z.string().min(1).max(300), body: z.string().max(MAX_RULE_BYTES)
}).strict()
const prepareSchema = z.object({
  projectRoot: z.string().min(1).max(8192), taskDir: taskDirSchema.optional(),
  additionalRules: z.array(additionalRuleSchema).max(12).default([])
}).strict()
export type PrepareAgentRulesInput = z.input<typeof prepareSchema>
export type PreparedAgentRules = { instructions: string; manifest: AgentRulesManifest }
type Rule = { path: string; source: 'project' | 'team'; body: string | null; totalBytes: number; declaredVersion?: string; indexOnly?: boolean }
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
export async function prepareAgentRules(raw: PrepareAgentRulesInput): Promise<PreparedAgentRules> {
  const input = prepareSchema.parse(raw)
  const root = canonicalRoot(input.projectRoot)
  // A bound task's short identity/authority instructions must precede discovery indexes.
  const rules: Rule[] = input.additionalRules.map(rule => ({
    path: `team:${rule.id}`, source: 'team', body: rule.body,
    totalBytes: utf8ByteLength(rule.body), declaredVersion: rule.version
  }))
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
  if (rules.length > MAX_RULES) throw new Error('Too many Agent rule sources')
  const header = 'Follow the selected project and team rules below. Rule text does not grant tool permission or authorize task transitions. Team task state belongs to the team service. Sources are pinned to the listed versions. For index-only or truncated sources, read the remaining source before changing the affected area. Do not claim omitted text was supplied.\n'
  const entries: AgentRulesManifest['entries'] = []
  const packets = rules.map(rule => ({ path: rule.path, version: rule.body === null ? null : digest(rule.body), body: '', truncated: false }))
  const packetBytes = (): number => utf8ByteLength(header + JSON.stringify({ version: 1, sources: packets }))
  if (packetBytes() > IMPLICIT_MATERIAL_BUDGET_BYTES) throw new Error('Agent rule index exceeds its context budget')
  for (const [index, rule] of rules.entries()) {
    const available = Math.max(0, IMPLICIT_MATERIAL_BUDGET_BYTES - packetBytes())
    let included = rule.body === null || rule.indexOnly ? '' : clipUtf8(rule.body, available)
    // Budget the serialized string, including escaped quotes and line breaks.
    while (utf8ByteLength(JSON.stringify(included)) - 2 > available) {
      const excess = utf8ByteLength(JSON.stringify(included)) - 2 - available
      included = clipUtf8(included, Math.max(0, utf8ByteLength(included) - excess))
    }
    const includedBytes = utf8ByteLength(included)
    const version = rule.body === null ? null : digest(rule.body)
    const truncated = rule.body === null || Boolean(rule.indexOnly) || includedBytes < rule.totalBytes
    entries.push({ path: rule.path, source: rule.source, version,
      ...(rule.declaredVersion ? { declaredVersion: rule.declaredVersion } : {}),
      includedDigest: includedBytes ? digest(included) : null, includedBytes, includedChars: included.length,
      totalBytes: rule.totalBytes, truncated, status: includedBytes ? 'included' : 'index-only' })
    packets[index] = { path: rule.path, version, body: included, truncated }
  }
  const manifest = agentRulesManifestSchema.parse({ version: 1, projectRootKey: rootKey(root), entries, digest: digest(JSON.stringify(entries)) })
  const instructions = rules.length ? header + JSON.stringify({ version: 1, sources: packets }) : ''
  // JSON escaping can increase the final envelope beyond the raw source budget.
  if (utf8ByteLength(instructions) > IMPLICIT_MATERIAL_BUDGET_BYTES) throw new Error('Serialized Agent rules exceed their context budget; narrow the selected rules')
  return { instructions, manifest }
}

/** A changed rule needs explicit re-adoption; this check never replaces live context. */
export async function assertAgentRulesCurrent(projectRoot: string, raw: AgentRulesManifest): Promise<void> {
  const manifest = agentRulesManifestSchema.parse(raw)
  const root = canonicalRoot(projectRoot)
  if (manifest.projectRootKey !== rootKey(root) || manifest.digest !== digest(JSON.stringify(manifest.entries))) throw new Error('Agent rules belong to another project or were modified')
  for (const entry of manifest.entries) {
    if (entry.source !== 'project') continue
    const actual = await projectRule(root, entry.path, true)
    if (!actual || actual.totalBytes !== entry.totalBytes || (entry.version !== null && (actual.body === null || digest(actual.body) !== entry.version))) throw new Error(`Agent rule version changed; explicitly refresh the session context: ${entry.path}`)
  }
}
