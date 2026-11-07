import { app } from 'electron'
import { createHash } from 'node:crypto'
import { CreationMainService } from './service'
import { WhiteboardV2Service } from './whiteboard-v2-service'
import { WhiteboardV2WorkerClient } from './whiteboard-v2-worker-client'
import { whiteboardV2Workspace } from './whiteboard-v2-workspace'
import type { WhiteboardWorkerWrite } from './whiteboard-v2-worker-protocol'
import { cruxStableWorkspaceGeneration, cruxWorkspaceSnapshot, cruxWorkspaceStatus } from '../crux/connection-service'
import { withDesktopTeamService } from '../team-desktop'
import { getSettings } from '../store'
import { aiChat } from '../ai'
import { broadcastToWindows } from '../bridge'
import { ipcEvent } from '../../../shared/ipc-channels'
import { creationReferencePath, type CreationMaterialReference, type CreationMaterialFile } from '../../../shared/creation-materials'
import type { CruxWorkQuery } from '../../../shared/crux-work'
import { selectTaskCreationReferences } from './task-references'

let service: CreationMainService | null = null
let whiteboard: WhiteboardV2Service | null = null
let openingWhiteboard: Promise<WhiteboardV2Service> | null = null
let closing: Promise<void> | null = null
let closed = false
export function creationService(): CreationMainService {
  if (closed) throw Object.assign(new Error('创作服务正在退出'), { code: 'SERVICE_CLOSED' })
  service ??= new CreationMainService({ dataDir: app.getPath('userData'), workspace: cruxWorkspaceSnapshot, status: cruxWorkspaceStatus,
    remote: withDesktopTeamService, model: () => getSettings().ai, chat: aiChat,
    changed: (workspaceKey, creationId) => broadcastToWindows(ipcEvent.creationsChanged, { workspaceKey, creationId }) })
  return service
}
/** Main-process only; no renderer-supplied actor, source or storage path. */
export function whiteboardV2Service(): Promise<WhiteboardV2Service> {
  if (closed) return Promise.reject(Object.assign(new Error('创作服务正在退出'), { code: 'SERVICE_CLOSED' }))
  if (whiteboard) return Promise.resolve(whiteboard)
  if (!openingWhiteboard) {
    const opening = WhiteboardV2WorkerClient.open({ root: app.getPath('userData') }).then((store) => {
      const value = new WhiteboardV2Service({ store, workspace: whiteboardV2Workspace, status: cruxWorkspaceStatus, generation: cruxStableWorkspaceGeneration })
      whiteboard = value
      return value
    })
    openingWhiteboard = opening
    void opening.finally(() => { if (openingWhiteboard === opening) openingWhiteboard = null }).catch(() => {})
  }
  return openingWhiteboard.then((value) => {
    if (closed) throw Object.assign(new Error('创作服务正在退出'), { code: 'SERVICE_CLOSED' })
    return value
  })
}
/** Main-only retained cleanup evidence, including after admission has closed. */
export function retainedWhiteboardWrites(): WhiteboardWorkerWrite[] { return whiteboard?.retainedWrites() ?? [] }
export function closeCreationService(): Promise<void> {
  closed = true
  if (closing) return closing
  // Fence both instantiated services before awaiting either one.
  const legacy = service?.close() ?? Promise.resolve()
  const whiteboardClose = whiteboard ? whiteboard.close() : openingWhiteboard ? openingWhiteboard.then((value) => value.close(), () => {}) : null
  if (!whiteboardClose) return legacy
  const work = Promise.allSettled([legacy, whiteboardClose]).then((results) => {
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  })
  closing = work
  void work.catch(() => { if (closing === work) closing = null })
  return work
}

export async function taskCreationReferences(query: CruxWorkQuery): Promise<CreationMaterialReference[]> {
  const result = await creationService().list({ workspaceKey: query.workspaceKey, scope: 'team', taskId: query.taskId, limit: 20 })
  return selectTaskCreationReferences(query, result)
}
export async function taskCreationFiles(query: CruxWorkQuery, references: CreationMaterialReference[]): Promise<CreationMaterialFile[]> {
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
