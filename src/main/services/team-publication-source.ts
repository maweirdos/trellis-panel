/** Main-only selected-source adapter; server publication authority is separate. */
import { desktopWorkflowPublicationSchema, type DesktopWorkflowPublicationInput } from '../../shared/team-desktop-bridge'
import type { StoredWorkflowMaterial } from './workflow-runtime/types'
import { getDocumentViews } from './document-views'
import { getWorkflowApplication } from './daemon-client/workflow'

export async function resolveTeamPublicationSource(root: string, raw: DesktopWorkflowPublicationInput['source']): Promise<StoredWorkflowMaterial> {
  const source = desktopWorkflowPublicationSchema.shape.source.parse(raw)
  if (source.kind === 'fixed-document') {
    const reader = getDocumentViews()
    if (!reader) throw Object.assign(new Error('固定文档阅读服务尚未就绪'), { code: 'SOURCE_UNSUPPORTED' })
    return reader.selectedMaterial(root, source.token)
  }
  const application = await getWorkflowApplication(root)
  return source.kind === 'task-run'
    ? application.readArtifact({ taskDir: source.taskDir, run: source.run, ref: source.ref })
    : application.readRecoveryArtifact({ run: source.run, ref: source.ref })
}
