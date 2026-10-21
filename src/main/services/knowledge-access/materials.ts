import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { KnowledgeArtifact, KnowledgeArtifactSaveInput, KnowledgeProjectInput } from '../../../shared/knowledge-access'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { IntegrationError } from '../integrations/types'
import { readKnowledgeState, updateKnowledgeState, knowledgeHash } from './repository'

export function materialPath(root: string, relativePath: string): string {
  const authorized = resolveAuthorizedDocumentPath(root, relativePath)
  if (!authorized.ok) throw new IntegrationError('项目材料路径越界', 'denied')
  return authorized.absPath
}
export function materialRead(root: string, relativePath: string): { body: string; revision: string | null } {
  const path = materialPath(root, relativePath)
  if (!existsSync(path)) return { body: '', revision: null }
  try {
    if (!statSync(path).isFile() || statSync(path).size > 1024 * 1024) throw new Error('limit')
    const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path))
    return { body, revision: knowledgeHash(body) }
  } catch { throw new IntegrationError('项目材料不可读取或超过 1 MiB，未视为不存在', 'io') }
}
/** Synchronous compare/recheck with atomic replacement; new files use exclusive link admission. */
export function materialWrite(root: string, relativePath: string, body: string, expected: string | null): { body: string; revision: string | null } {
  const previous = materialRead(root, relativePath)
  if (previous.revision !== expected) throw new IntegrationError('项目材料已被修改，请重新读取并确认新版本', 'conflict')
  let path = materialPath(root, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  path = materialPath(root, relativePath)
  const tmp = join(dirname(path), `.knowledge-${randomUUID()}.tmp`)
  try {
    writeFileSync(tmp, body, { encoding: 'utf8', flag: 'wx' })
    if (materialRead(root, relativePath).revision !== expected) throw new IntegrationError('项目材料在保存期间发生变化', 'conflict')
    if (expected === null) { linkSync(tmp, path); unlinkSync(tmp) }
    else renameSync(tmp, path)
    return previous
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* Keep the original material on cleanup failure. */ }
    if (error instanceof IntegrationError) throw error
    throw new IntegrationError('项目材料原子保存失败；未确认保存成功', 'io')
  }
}
export function artifactRead(root: string, artifactId: string, revision: string): KnowledgeArtifact {
  const record = readKnowledgeState(root).artifacts.find((item) => item.id === artifactId && item.revision === revision)
  if (!record) throw new IntegrationError('所选确认材料版本不存在', 'invalid')
  return record
}
export function assertArtifactCurrent(root: string, artifact: KnowledgeArtifact): void {
  if (materialRead(root, artifact.relativePath).revision !== artifact.revision) throw new IntegrationError('材料已修改或删除，需重新读取、确认并保存新版本', 'conflict')
}
function rollbackMaterial(root: string, path: string, newRevision: string, previous: { body: string; revision: string | null }): void {
  try {
    if (materialRead(root, path).revision !== newRevision) return
    if (previous.revision === null) unlinkSync(materialPath(root, path))
    else materialWrite(root, path, previous.body, newRevision)
  } catch { /* Surface failure; never overwrite a later external edit to roll back metadata. */ }
}
export function saveKnowledgeArtifact(root: string, input: KnowledgeArtifactSaveInput, conversation?: { id: string; origin: NonNullable<KnowledgeArtifact['origin']> }): KnowledgeArtifact {
  const state = readKnowledgeState(root)
  const previous = input.id ? state.artifacts.find((item) => item.id === input.id) : undefined
  if (input.id && !previous) throw new IntegrationError('材料身份不存在，请先保存为新材料', 'conflict')
  const id = previous?.id ?? conversation?.id ?? randomUUID()
  const relativePath = previous?.relativePath ?? `.trellis/notes/${input.kind}-${id}.md`
  const sourceIds = [...new Set(input.sourceIds ?? [])]
  for (const sourceId of sourceIds) if (!state.sources.some((item) => item.source.id === sourceId)) throw new IntegrationError('材料引用了未持久化或外部来源，请重新检索后确认', 'denied')
  const artifact: KnowledgeArtifact = { id, revision: knowledgeHash(input.body), title: input.title, kind: input.kind, relativePath, body: input.body, sourceIds, sessionId: input.sessionId || 'ui', turnId: input.turnId || '', createdAt: Date.now(), confirmed: !conversation, ...(conversation ? { origin: conversation.origin } : {}) }
  const duplicate = state.artifacts.find((item) => item.id === id && item.revision === artifact.revision)
  if (duplicate && (duplicate.title !== artifact.title || duplicate.kind !== artifact.kind || JSON.stringify(duplicate.sourceIds) !== JSON.stringify(artifact.sourceIds))) throw new IntegrationError('相同正文版本的标题或引用不同，请修改正文并保存新版本', 'conflict')
  const oldMaterial = materialWrite(root, relativePath, artifact.body, input.expectedRevision ?? null)
  try {
    updateKnowledgeState(root, (next) => { if (!duplicate) next.artifacts.unshift(artifact) })
  } catch (error) { rollbackMaterial(root, relativePath, artifact.revision, oldMaterial); throw error }
  return duplicate ?? artifact
}
function taskPath(root: string, taskDir: string): string {
  if (!taskDir || taskDir.length > 256 || taskDir === '.' || taskDir === '..' || taskDir === 'archive' || /[/\\:\x00-\x1f]/.test(taskDir)) throw new IntegrationError('请选择当前项目的活动开发任务', 'invalid')
  const record = materialRead(root, `.trellis/tasks/${taskDir}/task.json`)
  try {
    const parsed: unknown = JSON.parse(record.body)
    if (!parsed || typeof parsed !== 'object' || !('id' in parsed) || typeof parsed.id !== 'string' || !('status' in parsed) || typeof parsed.status !== 'string' || parsed.status === 'completed') throw new Error('inactive')
  } catch { throw new IntegrationError('请选择当前项目的活动开发任务', 'invalid') }
  return `.trellis/tasks/${taskDir}/prd.md`
}
export function readTaskPrd(root: string, input: KnowledgeProjectInput & { taskDir: string }): { body: string; revision: string | null } { return materialRead(root, taskPath(root, input.taskDir)) }
export function handoffKnowledgeArtifact(root: string, input: KnowledgeProjectInput & { artifactId: string; revision: string; taskDir: string; developerBody: string; expectedPrdRevision: string | null }): { taskDir: string; prdRevision: string; productPath: string; productRevision: string } {
  const artifact = artifactRead(root, input.artifactId, input.revision)
  assertArtifactCurrent(root, artifact)
  const path = taskPath(root, input.taskDir)
  const backlink = `> Product requirements: ${artifact.relativePath}\n> Product revision (sha256): ${artifact.revision}\n> Handoff records source only; it does not authorize implementation.\n\n`
  const body = backlink + input.developerBody
  const old = materialWrite(root, path, body, input.expectedPrdRevision)
  const prdRevision = knowledgeHash(body)
  try { updateKnowledgeState(root, (state) => { if (!state.handoffs.some((item) => item.artifactId === artifact.id && item.artifactRevision === artifact.revision && item.taskDir === input.taskDir && item.prdRevision === prdRevision)) state.handoffs.unshift({ artifactId: artifact.id, artifactRevision: artifact.revision, taskDir: input.taskDir, prdRevision, createdAt: Date.now() }) }) }
  catch (error) { rollbackMaterial(root, path, prdRevision, old); throw error }
  return { taskDir: input.taskDir, prdRevision, productPath: artifact.relativePath, productRevision: artifact.revision }
}
