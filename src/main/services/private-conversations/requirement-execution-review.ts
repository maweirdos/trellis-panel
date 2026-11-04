import { z } from 'zod'
import { canonicalWorkflowJson, runRefSchema, type RunRef } from '../../../shared/workflow'
import type { RequirementPredecessor } from '../../../shared/conversation-requirements'
import { directoryIdentity, hash, readRegular } from './files'
import { readOptional, utf8 } from './requirement-files'

/** The reviewed project instructions and task documents are read from the target, not the renderer. */
export function readExecutionReview(root: string, taskDir: string, taskId: string, origin: unknown): { digest: string; files: Array<{ path: string; digest: string; text: string }> } {
  const prefix = `.trellis/tasks/${taskDir}`
  const paths = ['.trellis/workflow.md', 'AGENTS.md', `${prefix}/prd.md`, `${prefix}/plan.md`, `${prefix}/design.md`, `${prefix}/implement.md`, `${prefix}/implement.jsonl`, `${prefix}/check.jsonl`]
  const required = new Set(['.trellis/workflow.md', `${prefix}/prd.md`, `${prefix}/plan.md`])
  const files: Array<{ path: string; digest: string; text: string }> = []
  let total = 0
  const add = (path: string): void => {
    const file = readOptional(root, path, 1024 * 1024)
    if (!file) { if (required.has(path)) throw new Error(`规划审阅缺少 ${path}`); return }
    total += file.bytes.length
    if (total > 2 * 1024 * 1024) throw new Error('规划审阅材料超过 2 MiB；未激活任务')
    files.push({ path, digest: hash(file.bytes), text: utf8(file.bytes) })
  }
  for (const path of paths) add(path)
  const manifest = files.find(file => file.path === `${prefix}/implement.jsonl`)
  if (manifest) {
    const seen = new Set(files.map(file => file.path))
    for (const line of manifest.text.split(/\r?\n/).filter(value => value.trim())) {
      const item = z.object({ file: z.string().min(1), reason: z.string().optional() }).passthrough().parse(JSON.parse(line))
      const path = item.file.replace(/\\/g, '/')
      if (seen.has(path)) continue
      if (path !== 'AGENTS.md' && !path.startsWith('.trellis/spec/') && !path.startsWith(`${prefix}/research/`)) throw new Error(`暂不支持将规划清单中的 ${path} 作为执行材料；请调整目标任务清单`)
      seen.add(path); required.add(path); add(path)
      if (files.length > 72) throw new Error('规划审阅材料数量超过上限')
    }
  }
  const script = readRegular(root, '.trellis/scripts/task.py', 1024 * 1024)
  const digest = hash(canonicalWorkflowJson(JSON.parse(JSON.stringify({ root, taskDir, taskId, origin, script: hash(script.bytes), files: files.map(({ path, digest: revision }) => ({ path, digest: revision })) }))))
  return { digest, files }
}

/** The journal lives under app-owned private metadata; task files alone are not an approval. */
export function assertExecutionReview(root: string, taskDir: string, taskId: string, origin: { creatorId: string; conversationId: string; draftId: string; predecessor?: RequirementPredecessor }, session: { sessionId: string; connectionGeneration: string }, metadataDirectory: string, knowledge: unknown[], references: unknown[], design: unknown[]): RunRef | undefined {
  const canonical = (value: unknown): string => canonicalWorkflowJson(JSON.parse(JSON.stringify(value)))
  const key = hash(canonical([origin.creatorId, origin.conversationId, origin.draftId, root, taskDir, taskId]))
  const bytes = readRegular(metadataDirectory, `requirement-executions/${key}.json`, 64 * 1024).bytes
  const receipt = z.object({ phase: z.literal('prepared'), reviewDigest: z.string().regex(/^[a-f0-9]{64}$/), knowledgeDigest: z.string().regex(/^[a-f0-9]{64}$/), referencesDigest: z.string().regex(/^[a-f0-9]{64}$/), designDigest: z.string().regex(/^[a-f0-9]{64}$/), predecessorRun: runRefSchema.optional(), reviewClassification: z.enum(['lightweight', 'complex']), taskIdentity: z.string(), sessionId: z.string(), connectionGeneration: z.string() }).passthrough().parse(JSON.parse(utf8(bytes)))
  if (receipt.sessionId !== session.sessionId || receipt.connectionGeneration !== session.connectionGeneration || receipt.taskIdentity !== directoryIdentity(`${root}/.trellis/tasks/${taskDir}`) || receipt.reviewDigest !== readExecutionReview(root, taskDir, taskId, origin).digest || receipt.knowledgeDigest !== hash(canonical(knowledge)) || receipt.referencesDigest !== hash(canonical(references)) || receipt.designDigest !== hash(canonical(design))) throw new Error('原规划审阅、会话或材料已变化，请回到原需求核对')
  if (Boolean(origin.predecessor) !== Boolean(receipt.predecessorRun)) throw new Error('后继任务的原运行身份没有被确认')
  return receipt.predecessorRun
}
