import { createHash } from 'node:crypto'
import { z } from 'zod'
import { requirementPredecessorSchema, requirementTaskOriginSchema, type RequirementPredecessor } from '../../../shared/conversation-requirements'
import { runRefSchema, type RunRef } from '../../../shared/workflow'
import { runtimeCall } from '../daemon-client/runtime'
import { directoryIdentity, readRegular } from './files'
import { RequirementError, utf8 } from './requirement-files'

export interface RequirementPredecessorReleaseProof {
  version: 1; predecessor: RequirementPredecessor; runId: string; runRevision: number
  terminalState: 'verified' | 'stopped' | 'cancelled' | 'failed'; evidenceDigest: string
}
const releasedSchema = z.object({ run: runRefSchema, state: z.enum(['verified', 'stopped', 'cancelled', 'failed']) }).strict()
export interface RequirementPredecessorReleasePorts {
  check(root: string, predecessor: RequirementPredecessor, expectedRun: RunRef | undefined, current: () => boolean): Promise<unknown>
}
const defaults: RequirementPredecessorReleasePorts = {
  check: (root, predecessor, expectedRun, current) => runtimeCall(root, 'runtime.workflow.requirementPredecessor', { predecessor, ...(expectedRun ? { expectedRun } : {}) }, undefined, current)
}

/** Reuses the daemon-owned workflow/native-session/workcopy release check. */
export async function verifyRequirementPredecessorRelease(raw: RequirementPredecessor, current: () => void, ports: RequirementPredecessorReleasePorts = defaults): Promise<RequirementPredecessorReleaseProof> {
  const predecessor = requirementPredecessorSchema.parse(raw), root = predecessor.task.root, initialIdentity = directoryIdentity(root)
  const assertOriginal = (): void => {
    current()
    if (directoryIdentity(root) !== initialIdentity) throw new RequirementError('原任务工程物理身份已变化', 'E_DENIED')
    const prefix = `.trellis/tasks/${predecessor.task.taskDir}`
    const task = z.object({ id: z.string(), meta: z.object({ conversationRequirement: requirementTaskOriginSchema }).passthrough() }).passthrough().parse(JSON.parse(utf8(readRegular(root, `${prefix}/task.json`, 512 * 1024).bytes)))
    const origin = task.meta.conversationRequirement
    if (task.id !== predecessor.task.taskId || origin.draftId !== predecessor.draftId || origin.commandId !== predecessor.handoffCommandId || origin.draftRevision !== predecessor.draftRevision || origin.confirmedRevision !== predecessor.confirmedRevision || origin.planRevision !== predecessor.planRevision || origin.bodyRevision !== predecessor.bodyRevision || origin.manifestRevision !== predecessor.manifestRevision || createHash('sha256').update(readRegular(root, `${prefix}/${origin.manifestPath}`, 64 * 1024).bytes).digest('hex') !== predecessor.manifestRevision) throw new RequirementError('原任务或固定交接身份已变化', 'E_DENIED')
  }
  const isCurrent = (): boolean => { try { assertOriginal(); return true } catch { return false } }
  assertOriginal()
  const first = releasedSchema.parse(await ports.check(root, predecessor, undefined, isCurrent))
  assertOriginal()
  const second = releasedSchema.parse(await ports.check(root, predecessor, first.run, isCurrent))
  assertOriginal()
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new RequirementError('原任务释放状态在核对期间发生变化', 'E_BUSY')
  return { version: 1, predecessor, runId: second.run.runId, runRevision: second.run.revision, terminalState: second.state, evidenceDigest: createHash('sha256').update(JSON.stringify([predecessor, initialIdentity, second])).digest('hex') }
}
