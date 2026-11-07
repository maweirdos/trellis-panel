import { createHash } from 'node:crypto'
import { cruxGovernanceInputPath, cruxGovernanceInputSchema, type CruxGovernanceInput, type CruxTeamInputSelection, type CruxWorkQuery } from '../../../shared/crux-work'
import type { CreationMaterialFile } from '../../../shared/creation-materials'
import { taskMaterialInputPath, taskMaterialInputReferenceSchema, type TaskMaterialInputReference } from '../../../shared/task-material-inputs'
import { createCruxGovernanceService } from './governance'
import { taskInputBundleDigestText, taskInputCanonical, type TaskInputRead } from '../../../shared/team-task-inputs'
import { cruxWorkspaceGeneration, cruxWorkspaceStatus } from './connection-service'
import { CruxWorkError } from './task-workspace-source'

type Scope = CruxWorkQuery & { spaceId: string; taskCreatedAt: string }
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export function selectTaskMaterialInputs(query: Pick<Scope, 'taskId' | 'spaceId' | 'taskCreatedAt'>, value: TaskInputRead): CruxTeamInputSelection {
  if (value.taskId !== query.taskId || value.spaceId !== query.spaceId || value.taskCreatedAt !== query.taskCreatedAt) throw new CruxWorkError('scope_changed', '已采用输入不属于原任务。')
  if (value.admission.status !== 'ready') throw new CruxWorkError('material_review_required', value.admission.blockers.join('；') || '请先在任务输入中完成固定版本评审与采纳。')
  const bundle = value.current
  if (bundle && (bundle.taskId !== query.taskId || bundle.spaceId !== query.spaceId || bundle.taskCreatedAt !== query.taskCreatedAt || hash(taskInputBundleDigestText(bundle)) !== bundle.digest)) throw new CruxWorkError('source_changed', '已采用输入的来源或固定摘要无法核对。')
  if (!bundle && !value.legacySummary) throw new CruxWorkError('material_review_required', '当前任务没有可核对的已采用输入，请先确认需求基线。')
  return bundle ? { references: bundle.documents, governance: cruxGovernanceInputSchema.parse({ bundleId: bundle.bundleId, revision: bundle.revision, digest: bundle.digest, rules: bundle.rules, template: bundle.template }) } : { references: [] }
}

export function createTaskMaterialInputs(dataDir: string): {
  inputs(query: Scope): Promise<CruxTeamInputSelection>
  references(query: Scope): Promise<TaskMaterialInputReference[]>
  files(query: CruxWorkQuery, references: TaskMaterialInputReference[]): Promise<CreationMaterialFile[]>
  governanceFiles(query: Scope, input: CruxGovernanceInput): Promise<CreationMaterialFile[]>
} {
  const governance = createCruxGovernanceService(dataDir)
  const inputs = async (query: Scope): Promise<CruxTeamInputSelection> => {
    const generation = cruxWorkspaceGeneration(), context = await cruxWorkspaceStatus()
    if (context.key !== query.workspaceKey) throw new CruxWorkError('scope_changed', '原任务材料来源已变化。')
    if (context.state === 'local') return { references: [] }
    const result = await governance.inputs(query)
    if (!result.ok) throw new CruxWorkError('access_locked', result.error)
    const selection = selectTaskMaterialInputs(query, result.value)
    if (cruxWorkspaceGeneration() !== generation || (await cruxWorkspaceStatus()).key !== context.key) throw new CruxWorkError('scope_changed', '读取固定输入期间原工作区已切换。')
    return selection
  }
  return {
    inputs,
    async references(query): Promise<TaskMaterialInputReference[]> { return (await inputs(query)).references },
    async files(query, references): Promise<CreationMaterialFile[]> {
      const files: CreationMaterialFile[] = []
      for (const raw of references) {
        const reference = taskMaterialInputReferenceSchema.parse(raw)
        const result = await governance.readDocument({ ...query, spaceId: reference.spaceId, taskCreatedAt: reference.taskCreatedAt, reference })
        if (!result.ok) throw new CruxWorkError('access_locked', result.error)
        const text = result.value.text
        if (result.value.taskId !== query.taskId || taskInputCanonical(result.value.reference) !== taskInputCanonical(reference)
          || hash(text) !== reference.bodyDigest || Buffer.byteLength(text, 'utf8') !== reference.byteLength) {
          throw new CruxWorkError('source_changed', '原团队文档的版本、正文或来源无法核对；不会替换成最新版。')
        }
        files.push({ relativePath: taskMaterialInputPath(reference), body: text, bodyDigest: reference.bodyDigest })
      }
      return files
    },
    async governanceFiles(query, input): Promise<CreationMaterialFile[]> {
      const selection = await inputs(query)
      if (!selection.governance || taskInputCanonical(selection.governance) !== taskInputCanonical(input)) throw new CruxWorkError('source_changed', '当前采用的规则或流程版本已变化，请创建明确的新尝试。')
      const files: CreationMaterialFile[] = []
      for (const reference of [...input.rules, ...(input.template ? [input.template] : [])]) {
        const result = await governance.read({ workspaceKey: query.workspaceKey, spaceId: query.spaceId, packageId: reference.packageId, versionId: reference.versionId })
        if (!result.ok) throw new CruxWorkError('access_locked', result.error)
        if (taskInputCanonical(result.value.selected) !== taskInputCanonical(reference) || hash(result.value.text) !== reference.bodyDigest || Buffer.byteLength(result.value.text, 'utf8') !== reference.byteLength) throw new CruxWorkError('source_changed', '团队规则的固定版本与实际正文不一致。')
        files.push({ relativePath: cruxGovernanceInputPath(reference.settings.kind, reference.packageId, reference.versionId), body: result.value.text, bodyDigest: reference.bodyDigest })
        if (files.reduce((bytes, file) => bytes + Buffer.byteLength(file.body, 'utf8'), 0) > 8 * 1024 * 1024) throw new CruxWorkError('invalid_input', '本次规则与模板正文超过 8 MiB，请缩小实际选用范围。')
      }
      const current = await inputs(query)
      if (taskInputCanonical(current.governance) !== taskInputCanonical(input)) throw new CruxWorkError('source_changed', '读取规则期间当前采用版本已变化。')
      return files
    }
  }
}
