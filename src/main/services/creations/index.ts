import { app } from 'electron'
import { createHash } from 'node:crypto'
import { CreationMainService } from './service'
import { hifoxWorkspaceSnapshot, hifoxWorkspaceStatus } from '../hifox/connection-service'
import { withDesktopTeamService } from '../team-desktop'
import { getSettings } from '../store'
import { aiChat } from '../ai'
import { broadcastToWindows } from '../bridge'
import { ipcEvent } from '../../../shared/ipc-channels'
import { creationReferencePath, type CreationMaterialReference, type CreationMaterialFile } from '../../../shared/creation-materials'
import type { HifoxWorkQuery } from '../../../shared/hifox-work'
import { selectTaskCreationReferences } from './task-references'

let service: CreationMainService | null = null
let closed = false
export function creationService(): CreationMainService {
  if (closed) throw Object.assign(new Error('创作服务正在退出'), { code: 'SERVICE_CLOSED' })
  service ??= new CreationMainService({ dataDir: app.getPath('userData'), workspace: hifoxWorkspaceSnapshot, status: hifoxWorkspaceStatus,
    remote: withDesktopTeamService, model: () => getSettings().ai, chat: aiChat,
    changed: (workspaceKey, creationId) => broadcastToWindows(ipcEvent.creationsChanged, { workspaceKey, creationId }) })
  return service
}
export function closeCreationService(): Promise<void> { closed = true; return service?.close() ?? Promise.resolve() }

export async function taskCreationReferences(query: HifoxWorkQuery): Promise<CreationMaterialReference[]> {
  const result = await creationService().list({ workspaceKey: query.workspaceKey, scope: 'team', taskId: query.taskId, limit: 20 })
  return selectTaskCreationReferences(query, result)
}
export async function taskCreationFiles(query: HifoxWorkQuery, references: CreationMaterialReference[]): Promise<CreationMaterialFile[]> {
  const files: CreationMaterialFile[] = []
  for (const reference of references) {
    const value = await creationService().get({ workspaceKey: query.workspaceKey, creationId: reference.creationId, revisionId: reference.revisionId })
    if (value.selected.bodyDigest !== reference.bodyDigest || !value.selected.published) throw new Error('所采用的原型修订不一致，已停止准备材料')
    files.push({ relativePath: creationReferencePath(reference), body: value.selected.body, bodyDigest: reference.bodyDigest })
    const body = JSON.stringify({ adoption: reference, scenarios: value.selected.scenarios }, null, 2)
    files.push({ relativePath: `references/${reference.creationId}/${reference.revisionId}.review.json`, body, bodyDigest: createHash('sha256').update(body).digest('hex') })
  }
  return files
}
