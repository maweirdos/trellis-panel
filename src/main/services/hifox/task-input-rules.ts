import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { teamTaskRulesContextSchema, type TeamTaskRulesContext, type TeamTaskRulesManifest } from '../../../shared/agent-rules'
import { hifoxGovernanceInputPath, hifoxWorkMaterialSchema } from '../../../shared/hifox-work'
import type { GovernanceVersion } from '../../../shared/team-governance'
import { taskDirSchema } from '../acp/types'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { HifoxWorkBindings, nativeRootKey, validateHifoxProject, type HifoxWorkRecord } from './task-workspace-records'
import { taskDevelopmentKey } from './task-development-identity'
import type { HifoxWorkSource } from './task-workspace-source'
import { executionInputViewSchema, executionInputResourceViewSchema, executionInputDigestText, type ExecutionInputSource, type ExecutionInputResource, type ExecutionInputView } from '../../../shared/team-execution-input'
import { taskInputCanonical } from '../../../shared/team-task-inputs'

export const MAX_TASK_RULE_BYTES = 128 * 1024
const MAX_INPUT_BYTES = 256 * 1024
const MAX_GOVERNANCE_BYTES = 8 * 1024 * 1024
const inputSchema = z.object({ projectRoot: z.string().min(1).max(8192), taskDir: taskDirSchema, teamTask: teamTaskRulesContextSchema }).strict()
export type TaskInputRulesInput = z.infer<typeof inputSchema>
/** The existing native task owner checks original account/device/epoch and task ACL. */
export type TaskInputRulesAuthority = {
  dataDir: string
  source: HifoxWorkSource
  assertCurrent(): void | Promise<void>
}
export type TaskInputRulesAuthorityCapture = (input: TaskInputRulesInput) => Promise<TaskInputRulesAuthority>
export type FixedTaskRule = { path: string; version: GovernanceVersion; body: string | null; required: boolean }
export type TaskInputRules = { rules: FixedTaskRule[]; manifest: TeamTaskRulesManifest }
export type FixedExecutionRules = { view: ExecutionInputView; node: Extract<ExecutionInputView['input']['definition']['nodes'][number], { kind: 'agent' }>;
  rules: Array<{ resource: ExecutionInputResource; body: string | null; status: 'available' | 'withdrawn' | 'unavailable' }>; assertCurrent(): Promise<void> }

/** Authenticated fixed sources have no native root/taskDir/JSONL prerequisite. */
export async function readExecutionInputRules(source: ExecutionInputSource, nodeId: string): Promise<FixedExecutionRules> {
  const view = executionInputViewSchema.parse(await source.read()), input = view.input
  if (view.purpose !== 'use' || hash(executionInputDigestText(input)) !== input.digest) throw new Error('Execution input is historical or its fixed digest is invalid')
  const node = input.definition.nodes.find(item => item.id === nodeId)
  if (!node || node.kind !== 'agent') throw new Error('Only a declared Agent node can compose model context')
  const resources = input.resources.filter(item => item.selection.nodeId === nodeId).sort((a, b) => a.selection.order - b.selection.order)
  if (resources.length > 24 || !resources.length || new Set(resources.map(item => item.selection.id)).size !== resources.length || new Set(resources.map(item => item.selection.order)).size !== resources.length) throw new Error('Invalid or oversized fixed stage selection')
  const agent = input.agents.find(item => item.roleId === node.roleId)
  if (!agent || !resources.some(item => item.selection.required && item.selection.source.kind === 'agent-instructions' && item.selection.source.roleId === node.roleId)) throw new Error('Captured Agent instructions are required for this node')
  for (const skill of agent.skills) if (!resources.some(item => item.selection.required && item.selection.source.kind === 'skill' && item.selection.source.roleId === node.roleId && item.selection.source.skillId === skill.skillId)) throw new Error('A captured bound skill is missing from this node')
  const rules = await Promise.all(resources.map(async resource => {
    const selection = resource.selection
    if (selection.phaseId !== node.phaseId || selection.stage !== node.stage) throw new Error('Selection stage differs from its fixed node')
    const statuses = view.resources.filter(item => item.selectionId === selection.id)
    if (statuses.length !== 1) throw new Error('Fixed input has an ambiguous source availability receipt')
    const result = executionInputResourceViewSchema.parse(await source.readResource(selection.id))
    if (result.inputDigest !== input.digest || taskInputCanonical(result.resource) !== taskInputCanonical(resource) || result.status !== statuses[0].status) throw new Error('Fixed source changed while assembling the node')
    if (selection.required && (result.status !== 'available' || result.text === null || selection.delivery !== 'full')) throw new Error('Required fixed input is missing, withdrawn or not fully selected')
    if (result.text !== null && (Buffer.byteLength(result.text, 'utf8') !== resource.byteLength || hash(result.text) !== resource.bodyDigest)) throw new Error('Fixed source body failed its exact UTF-8 digest/length check')
    const selectedSource = selection.source
    const sourceAgent = selectedSource.kind === 'agent-instructions' || selectedSource.kind === 'skill' ? input.agents.find(item => item.roleId === selectedSource.roleId) : undefined
    const captured = selectedSource.kind === 'agent-instructions' ? sourceAgent?.instructions : selectedSource.kind === 'skill' ? sourceAgent?.skills.find(item => item.skillId === selectedSource.skillId) : undefined
    if ((selection.source.kind === 'skill' || selection.source.kind === 'agent-instructions') && (!captured || captured.bodyDigest !== resource.bodyDigest || captured.byteLength !== resource.byteLength)) throw new Error('Agent/skill source differs from the original captured bytes')
    return { resource, body: result.status === 'available' ? result.text : null, status: result.status }
  }))
  const assertCurrent = async (): Promise<void> => {
    const current = executionInputViewSchema.parse(await source.read())
    if (taskInputCanonical(current) !== taskInputCanonical(view)) throw new Error('Original execution input authority or source status changed')
  }
  await assertCurrent()
  return { view, node, rules, assertCurrent }
}
let authorityCapture: TaskInputRulesAuthorityCapture | undefined

/** Installed by the daemon's task owner, never by a renderer or a selected GUI root. */
export function installTaskInputRulesAuthority(capture: TaskInputRulesAuthorityCapture): () => void {
  if (authorityCapture) throw new Error('Fixed team rule context already has a native task owner')
  authorityCapture = capture
  return () => { if (authorityCapture === capture) authorityCapture = undefined }
}

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
function filePath(root: string, path: string): string {
  const authorized = resolveAuthorizedDocumentPath(root, path)
  if (!authorized.ok || !authorized.exists || nativeRootKey(authorized.canonicalPath) !== nativeRootKey(resolve(root, path))) throw new Error(`固定团队输入路径缺失、越界或被重定向：${path}`)
  return authorized.canonicalPath
}

/** Exact bytes, bounded descriptor reads and before/after identity checks; no BOM normalization. */
function readFixedFile(root: string, path: string, limit: number, expected?: { bodyDigest: string; byteLength: number }): { body: string | null; digest: string; bytes: number } {
  const physical = filePath(root, path)
  const descriptor = openSync(physical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.nlink !== 1 || before.size > limit || expected && before.size !== expected.byteLength) throw new Error(`固定团队输入不是普通文件或长度超限：${path}`)
    const checksum = createHash('sha256'), chunk = Buffer.alloc(Math.min(before.size + 1, 32 * 1024))
    const retained: Buffer[] = []
    let bytes = 0
    for (;;) {
      const read = readSync(descriptor, chunk, 0, Math.min(chunk.length, limit - bytes + 1), null)
      if (!read) break
      bytes += read
      if (bytes > limit || bytes > before.size) throw new Error(`固定团队输入在读取期间变长：${path}`)
      checksum.update(chunk.subarray(0, read))
      if (before.size <= MAX_TASK_RULE_BYTES || !expected) retained.push(Buffer.from(chunk.subarray(0, read)))
    }
    const after = fstatSync(descriptor), current = statSync(filePath(root, path))
    for (const info of [after, current]) {
      if (info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size || info.mtimeMs !== before.mtimeMs || info.ctimeMs !== before.ctimeMs || info.nlink !== 1 || bytes !== before.size) throw new Error(`固定团队输入在读取期间被替换或修改：${path}`)
    }
    const digest = checksum.digest('hex')
    if (expected && digest !== expected.bodyDigest) throw new Error(`固定团队输入正文与已采用版本不一致：${path}`)
    const body = before.size <= MAX_TASK_RULE_BYTES || !expected ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(retained)) : null
    return { body, digest, bytes }
  } finally { closeSync(descriptor) }
}

const diskTaskSchema = z.object({ id: z.string().min(1), status: z.string(), meta: z.record(z.string(), z.unknown()).default({}) }).passthrough()
function taskRecord(root: string, taskDir: string): z.infer<typeof diskTaskSchema> { return diskTaskSchema.parse(JSON.parse(readFixedFile(root, `.trellis/tasks/${taskDir}/task.json`, 1024 * 1024).body ?? '')) }

/** A taskDir is a locator, not a team-context grant for ordinary new conversations. */
export function assertNoUnownedTeamTaskRules(root: string, taskDir?: string): void {
  if (!taskDir) return
  const path = resolveAuthorizedDocumentPath(root, `.trellis/tasks/${taskDir}/task.json`)
  if (!path.ok) throw new Error('任务规则目录越界')
  if (!path.exists) return
  const task = taskRecord(root, taskDir)
  if (task.meta.panel_task_authority === 'team' || typeof task.meta.panel_hifox_workspace_key === 'string' && task.meta.panel_hifox_workspace_key !== 'local') throw new Error('团队任务规则必须通过原任务的本机执行入口授权，不能仅凭任务目录新建会话')
}

function assertTaskIdentity(root: string, taskDir: string, record: HifoxWorkRecord, teamTask: TeamTaskRulesContext): void {
  const task = taskRecord(root, taskDir), meta = task.meta
  if (record.identityVersion !== 2 || !record.taskCreatedAt || !record.localTaskId || record.stage !== 'ready'
    || nativeRootKey(record.projectRoot) !== nativeRootKey(root) || record.relativeDir !== `.trellis/tasks/${taskDir}`
    || record.sourceTaskId !== teamTask.taskId || record.spaceId !== teamTask.spaceId || record.sourceRevision !== teamTask.inputVersion
    || task.id !== record.localTaskId || ['completed', 'done', 'cancelled'].includes(task.status)
    || meta.panel_operation_id !== record.commandId || meta.panel_hifox_workspace_key !== record.workspaceKey
    || meta.panel_hifox_space_id !== record.spaceId || meta.panel_hifox_task_id !== record.sourceTaskId
    || meta.panel_hifox_identity !== record.ownerIdentity || meta.panel_hifox_task_created_at !== record.taskCreatedAt
    || meta.panel_hifox_source_revision !== teamTask.inputVersion
    || record.generation !== undefined && meta.panel_hifox_generation !== String(record.generation)) throw new Error('原任务的创建身份、固定输入或本机开发尝试已变化；请从团队任务核对并显式准备新会话')
}

function assertGovernance(rules: GovernanceVersion[], template: GovernanceVersion | null): void {
  if (template && template.settings.kind !== 'workflow-template' || rules.some(rule => rule.settings.kind !== 'rule') || new Set([...rules, ...(template ? [template] : [])].map(rule => rule.packageId)).size !== rules.length + (template ? 1 : 0)) throw new Error('固定团队规则与模板的种类或包身份不一致')
  for (const rule of rules) {
    const settings = rule.settings
    if (settings.kind !== 'rule' || settings.obligation !== 'required' || !settings.conflictKey) continue
    if (rules.some(other => other.packageId !== rule.packageId && other.settings.kind === 'rule' && other.settings.obligation === 'required'
      && other.settings.conflictKey === settings.conflictKey && other.settings.priority === settings.priority && other.bodyDigest !== rule.bodyDigest)) throw new Error(`必需团队规则存在同优先级冲突：${rule.title}。请规则负责人缩减或调整已选范围后重新采用`)
  }
}

/** Read only the original fixed projection after native authority and private binding agree. */
export async function readTaskInputRules(raw: TaskInputRulesInput): Promise<TaskInputRules> {
  const input = inputSchema.parse(raw), capture = authorityCapture
  if (!capture) throw new Error('原任务规则授权尚未由本机执行所有者安装，不能沿用旧会话或目录推断权限')
  const root = validateHifoxProject(input.projectRoot, true)
  const authority = await capture(input), source = authority.source
  if (source.taskId !== input.teamTask.taskId || source.spaceId !== input.teamTask.spaceId
    || input.teamTask.workcopyTaskKey !== undefined && taskDevelopmentKey(source) !== input.teamTask.workcopyTaskKey) throw new Error('团队规则授权不属于原任务、账号或创建身份')
  const bindings = new HifoxWorkBindings(authority.dataDir), stored = bindings.read(source)
  if (!stored) throw new Error('当前账号没有原任务的私有本机绑定，不能从共享目录借用其他成员的规则授权')
  const record = stored.value
  assertTaskIdentity(root, input.taskDir, record, input.teamTask)
  const sourcePath = `.trellis/tasks/${input.taskDir}/references/source-materials.json`
  const fixed = readFixedFile(root, sourcePath, MAX_INPUT_BYTES)
  if (fixed.digest !== input.teamTask.inputVersion || fixed.digest !== hash(JSON.stringify(record.material))) throw new Error('source-materials.json 实际字节摘要与原任务固定输入不一致；请核对并显式重新准备，未采用新正文')
  const material = hifoxWorkMaterialSchema.parse(JSON.parse(fixed.body ?? ''))
  if (JSON.stringify(material) !== JSON.stringify(record.material)) throw new Error('固定输入与本机私有材料记录不一致')
  const governance = material.governance
  assertGovernance(governance?.rules ?? [], governance?.template ?? null)
  const references = [...governance?.rules ?? [], ...(governance?.template ? [governance.template] : [])]
  if (references.reduce((bytes, ref) => bytes + ref.byteLength, 0) > MAX_GOVERNANCE_BYTES) throw new Error('固定团队规则正文超过 8 MiB 本机包上限，请缩减选用范围')
  const rules: FixedTaskRule[] = references.map(version => {
    const path = `.trellis/tasks/${input.taskDir}/${hifoxGovernanceInputPath(version.settings.kind, version.packageId, version.versionId)}`
    const required = version.settings.kind === 'workflow-template' || version.settings.obligation === 'required'
    if (required && version.byteLength > MAX_TASK_RULE_BYTES) throw new Error(`必需规则「${version.title}」超过 128 KiB 读取上限，请缩减选用范围后重新采用，不能以索引代替完整提供`)
    const file = readFixedFile(root, path, 1024 * 1024, version)
    return { path, version, body: file.body, required }
  })
  await authority.assertCurrent()
  if (authorityCapture !== capture) throw new Error('原任务规则授权所有者已释放或切换')
  const current = bindings.read(source)
  if (!current || current.revision !== stored.revision || current.storagePath !== stored.storagePath) throw new Error('读取规则期间原任务私有绑定已变化，未提供新上下文')
  assertTaskIdentity(validateHifoxProject(input.projectRoot, true), input.taskDir, current.value, input.teamTask)
  if (readFixedFile(root, sourcePath, MAX_INPUT_BYTES).digest !== fixed.digest) throw new Error('读取规则期间固定输入已被修改')
  return { rules, manifest: {
    ...input.teamTask, taskDir: input.taskDir, taskCreatedAt: source.taskCreatedAt,
    operationId: record.commandId, localTaskId: record.localTaskId ?? '',
    ...(governance ? { bundle: { id: governance.bundleId, revision: governance.revision, digest: governance.digest } } : {}),
    selected: rules.map(rule => ({ path: rule.path, version: rule.version, status: 'omitted', reason: 'source-limit' }))
  } }
}
