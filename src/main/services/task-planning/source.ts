import { currentPostInput, fixedPostInput } from '../../../shared/crux'
import { agentAttachment, readAgentAttachments } from '../crux/post-attachments'
import { createCruxTaskMaterialsService } from '../crux/task-materials'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { taskPlanningQuerySchema, type TaskPlanningQuery } from '../../../shared/task-planning'
import { nativePreparationPinSchema } from '../../../shared/native-task-preparation'
import { teamTaskRefSchema } from '../../../shared/team-task-execution'
import { taskInputCanonical, taskInputBundleDigestText, taskInputBundleSchema } from '../../../shared/team-task-inputs'
import { teamTaskDevelopmentContextSchema } from '../../../shared/team-task-development'
import { cruxGovernanceInputSchema } from '../../../shared/crux-work'
import { teamCodeResourceSchema } from '../../../shared/team-code-resources'
import { cruxWorkProjectIdentity, inspectCruxWorkExecutionProject } from '../crux/work-project'
import { createTaskMaterialInputs } from '../crux/task-material-inputs'
import { checkedDirectory, hash, readRegular } from '../private-conversations/files'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const fileSchema = z.object({ path: z.string().min(1).max(8192), body: z.string().max(200_000), digest, bytes: z.number().int().nonnegative() }).strict()
export const taskPlanningSourceSchema = z.object({
  version: z.literal(1), query: taskPlanningQuerySchema, pin: nativePreparationPinSchema, task: teamTaskRefSchema,
  taskUpdatedAt: z.string(), title: z.string(), description: z.string(), acceptanceCriteria: z.array(z.string()),
  inputBundle: taskInputBundleSchema.nullable(),
  resource: teamCodeResourceSchema.nullable(), resourceSelection: z.string(),
  root: z.string().min(1).max(8192), directoryIdentity: digest, repository: z.string(),
  documents: z.array(fileSchema).max(80), observations: z.array(fileSchema).max(64), attachments: z.array(agentAttachment).optional(),
  digest
}).strict()
export type TaskPlanningSource = z.infer<typeof taskPlanningSourceSchema>
export interface TaskPlanningSourceAccess {
  pin: z.infer<typeof nativePreparationPinSchema>
  context: z.infer<typeof teamTaskDevelopmentContextSchema>
  assertCurrent(): void
}
const corePaths = ['AGENTS.md', 'CLAUDE.md', 'CODEX.md', 'PRODUCT.md', 'DESIGN.md', '.trellis/workflow.md', '.trellis/spec/index.md', '.trellis/spec/backend/index.md', '.trellis/spec/frontend/index.md', '.trellis/spec/shared/index.md', 'package.json']
const decoder = new TextDecoder('utf-8', { fatal: true })
const sourceDigest = (source: Omit<TaskPlanningSource, 'digest'>): string => hash(taskInputCanonical(source))

/** Full bodies only. An index or missing optional file never masquerades as a full rule. */
export async function captureTaskPlanningSource(
  dataDir: string, query: TaskPlanningQuery, access: TaskPlanningSourceAccess, root: string, selected: string[] = []
): Promise<TaskPlanningSource> {
  access.assertCurrent()
  const { context, pin } = access, task = context.snapshot.snapshot.tasks.find(item => item.id === query.taskId)
  if (!task || task.spaceId !== query.spaceId || task.createdAt !== query.taskCreatedAt || task.workKind !== 'code'
    || task.workflow?.stage !== 'planning' || (task.workflow.handlerId ?? task.assigneeIds[0]) !== pin.actorId
    || context.snapshot.actor.id !== pin.actorId || context.snapshot.instanceId !== pin.instanceId
    || context.snapshot.projectId !== pin.projectId || context.snapshot.epoch !== pin.epoch
    || context.inputs.taskId !== query.taskId || context.inputs.spaceId !== query.spaceId || context.inputs.taskCreatedAt !== query.taskCreatedAt) throw Error('请由原任务当前处理人在技术规划阶段继续。')
  const space = context.snapshot.snapshot.spaces.find(item => item.id === task.spaceId)
  if (!space || space.archived || !space.memberIds.includes(pin.actorId)) throw Error('原任务空间当前不可操作。')
  if (context.inputs.admission.status !== 'ready') throw Error(context.inputs.admission.blockers.join('；') || '请先完成任务要求的输入评审与采用。')
  const bundle = context.inputs.current
  if (bundle && (bundle.taskId !== query.taskId || bundle.spaceId !== query.spaceId || bundle.taskCreatedAt !== query.taskCreatedAt
    || hash(taskInputBundleDigestText(bundle)) !== bundle.digest)) throw Error('原任务采用的固定输入无法核对。')
  root = checkedDirectory(root)
  const directoryIdentity = cruxWorkProjectIdentity(root), resource = context.codeResource.resource
  if (!resource) throw Error('请先选择原任务的代码资源。')
  const project = await inspectCruxWorkExecutionProject(root, resource)
  access.assertCurrent()
  if (!project.resourceMatched || directoryIdentity !== cruxWorkProjectIdentity(root)) throw Error('所选物理目录与原任务代码资源不匹配。')
  const materials = createTaskMaterialInputs(dataDir)
  const documents = await materials.files(query, bundle?.documents ?? [])
  if (bundle) documents.push(...await materials.governanceFiles(query, cruxGovernanceInputSchema.parse({
    bundleId: bundle.bundleId, revision: bundle.revision, digest: bundle.digest, rules: bundle.rules, template: bundle.template
  })))
  access.assertCurrent()
  const observations: TaskPlanningSource['observations'] = []
  const paths = [...new Set([...corePaths.filter(path => existsSync(`${root}/${path}`)), ...selected])]
  if (paths.length > 64) throw Error('固定工程资料最多 64 份，请缩小选取范围。')
  for (const path of paths) {
    if (path.includes('\\') || /(^|\/)(?:\.git|node_modules|\.env(?:\..*)?|credentials(?:\..*)?|auth\.json|secrets(?:\..*)?)(\/|$)/i.test(path)) throw Error('规划资料不能包含凭据、依赖目录或 Git 内部数据。')
    const actual = readRegular(root, path, 256 * 1024), body = decoder.decode(actual.bytes)
    observations.push(fileSchema.parse({ path, body, digest: hash(actual.bytes), bytes: actual.bytes.length }))
  }
  const fixed = documents.map(file => {
    if (hash(file.body) !== file.bodyDigest) throw Error('固定团队材料正文摘要不一致。')
    return fileSchema.parse({ path: file.relativePath, body: file.body, digest: file.bodyDigest, bytes: Buffer.byteLength(file.body) })
  })
  const post = fixedPostInput(task) ?? currentPostInput(task, context.snapshot.snapshot.comments)
  const attachments = await readAgentAttachments(dataDir, query, pin.actorId, post.sources, createCruxTaskMaterialsService(dataDir).sourcePart, access.assertCurrent)
  const source: Omit<TaskPlanningSource, 'digest'> = {
    version: 1, query, pin, task: { instanceId: pin.instanceId, projectId: pin.projectId, spaceId: task.spaceId, taskId: task.id, taskCreatedAt: task.createdAt },
    taskUpdatedAt: task.updatedAt, title: post.title, description: post.description, acceptanceCriteria: post.acceptanceCriteria,
    ...(attachments.length ? { attachments } : {}),
    inputBundle: bundle, resource, resourceSelection: taskInputCanonical(context.codeResource.selection),
    root, directoryIdentity, repository: taskInputCanonical(project.git), documents: fixed, observations
  }
  const text = taskInputCanonical(source)
  if (Buffer.byteLength(text) > 768 * 1024 || text.length > 170_000) throw Error('本次固定资料超过完整规划输入上限，请缩小选取范围；不会截断资料。')
  access.assertCurrent()
  return taskPlanningSourceSchema.parse({ ...source, digest: sourceDigest(source) })
}

export function assertTaskPlanningSource(source: TaskPlanningSource): void {
  const { digest: expected, ...body } = source
  if (sourceDigest(body) !== expected || cruxWorkProjectIdentity(source.root) !== source.directoryIdentity) throw Error('原规划来源或物理目录身份已变化。')
  for (const file of source.observations) {
    const current = readRegular(source.root, file.path, 256 * 1024)
    if (current.bytes.length !== file.bytes || hash(current.bytes) !== file.digest) throw Error(`固定工程资料已变化：${file.path}`)
  }
}
