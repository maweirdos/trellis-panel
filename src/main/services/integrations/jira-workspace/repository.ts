import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalWorkflowJson } from '../../../../shared/workflow'
import { JIRA_LIMITS } from '../../../../shared/jira-integration'
import { readBounded, writeAtomic } from '../../../daemon/files'
import { previewMaterialSchema, repositoryStateSchema, JiraWorkspaceError, type JiraRepositoryState, type JiraPreviewMaterial } from './types'

export function digest(value: unknown): string { return createHash('sha256').update(canonicalWorkflowJson(value)).digest('hex') }
/** Provider policy and evidence only; the common daemon repository owns jobs/outbox/commands. */
export class JiraWorkspaceRepository {
  private state: JiraRepositoryState | undefined
  private readonly file: string
  constructor(private readonly directory: string, private readonly assertOwner: () => void) {
    assertOwner()
    mkdirSync(directory, { recursive: true })
    this.file = join(directory, 'policy-and-evidence.json')
  }
  private load(): JiraRepositoryState {
    this.assertOwner()
    if (this.state) return this.state
    try {
      this.state = existsSync(this.file) ? repositoryStateSchema.parse(JSON.parse(readBounded(this.file, JIRA_LIMITS.evidenceBytes))) : { version: 1, businessDispatches: [], sources: [], accounts: [], plans: [], previews: [], baselines: [], receipts: [], conflicts: [], diagnostics: [] }
    } catch { throw new JiraWorkspaceError('E_IO', 'Jira policy/evidence is corrupt, oversized or from a future version. The original file is preserved.') }
    return this.state
  }
  read(): JiraRepositoryState { return structuredClone(this.load()) }
  change<T>(mutation: (state: JiraRepositoryState) => T): T {
    this.assertOwner()
    const next = structuredClone(this.load())
    const result = mutation(next)
    const checked = repositoryStateSchema.parse(next)
    const text = JSON.stringify(checked)
    if (Buffer.byteLength(text) > JIRA_LIMITS.evidenceBytes) throw new JiraWorkspaceError('E_BUSY', 'Jira evidence retention is full. Export/reconcile receipts before admitting more work.')
    this.assertOwner(); writeAtomic(this.file, text); this.state = checked
    return structuredClone(result)
  }
  retainPreview(material: JiraPreviewMaterial): void {
    this.assertOwner()
    const checked = previewMaterialSchema.parse(material)
    const { digest: expected, ...preview } = checked.preview
    if (digest({ preview, workspace: checked.workspace, items: checked.items }) !== expected) throw new JiraWorkspaceError('E_CONFLICT', 'Preview content digest does not match its retained material.')
    const text = JSON.stringify(checked)
    if (Buffer.byteLength(text) > JIRA_LIMITS.evidenceBytes) throw new JiraWorkspaceError('E_BUSY', 'Preview exceeds its retained byte budget. Reduce the query.')
    writeAtomic(this.previewPath(checked.preview.id), text)
    this.change((state) => { state.previews.push(checked.preview) })
  }
  preview(id: string): JiraPreviewMaterial {
    this.assertOwner()
    if (!this.load().previews.some((preview) => preview.id === id)) throw new JiraWorkspaceError('E_CONFLICT', 'The retained preview is unavailable.')
    try {
      const material = previewMaterialSchema.parse(JSON.parse(readBounded(this.previewPath(id), JIRA_LIMITS.evidenceBytes)))
      const { digest: expected, ...preview } = material.preview
      if (material.preview.id !== id || digest({ preview, workspace: material.workspace, items: material.items }) !== expected) throw new Error('digest')
      return material
    } catch { throw new JiraWorkspaceError('E_IO', 'Retained Jira preview failed integrity validation. It was not replaced.') }
  }
  private previewPath(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new JiraWorkspaceError('E_INVALID_ARG', 'Invalid preview ID.')
    return join(this.directory, `preview-${id}.json`)
  }
}
