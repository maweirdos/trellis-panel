import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import type { KnowledgeArtifact, KnowledgeScope } from '../../../shared/knowledge-access'
import type { KnowledgeConversationContext, KnowledgeConversationInput, KnowledgeConversationResult } from '../../../shared/knowledge-conversation'
import { createKnowledgePlanningTask } from './workspace-host'
import { IntegrationError } from '../integrations/types'
import { artifactRead, assertArtifactCurrent, handoffKnowledgeArtifact, materialPath, materialRead, readTaskPrd, saveKnowledgeArtifact } from './materials'
import { knowledgeHash, readKnowledgeState, readConversationActions, updateConversationActions, type ConversationAction } from './repository'
import { conversationOperationId, conversationPayloadHash } from '../knowledge-mcp/operation'
import type { KnowledgeAccessService } from './service'
import type { KnowledgeOwner } from './types'

type Action = ConversationAction
type Mutation = Exclude<KnowledgeConversationInput, { kind: 'context' | 'read_document' | 'read_task' }>

function normalize(input: KnowledgeConversationInput): KnowledgeConversationInput {
  return input.kind === 'save_document' ? { ...input, sourceIds: [...new Set(input.sourceIds ?? [])].sort() } : input
}
function turnOrigin(owner: KnowledgeOwner): NonNullable<KnowledgeArtifact['origin']> {
  if (!owner.connectionGeneration || typeof owner.originalUserText !== 'string') throw new IntegrationError('Trusted user turn provenance is unavailable', 'denied')
  return { kind: 'agent-conversation', connectionGeneration: owner.connectionGeneration, userRequestHash: knowledgeHash(owner.originalUserText), review: 'not_asserted' }
}

export class KnowledgeConversationWorkflow {
  private readonly inFlight = new Map<string, Promise<KnowledgeConversationResult>>()
  constructor(private readonly host: KnowledgeAccessService,
    private readonly assertOwner: (owner: KnowledgeOwner) => void,
    private readonly assertScope: (owner: KnowledgeOwner, scope: KnowledgeScope) => void) {}

  private current(owner: KnowledgeOwner, signal?: AbortSignal): void {
    this.assertOwner(owner)
    if (signal?.aborted) throw new IntegrationError('Conversation operation cancelled before the next action', 'conflict')
  }

  async run(owner: KnowledgeOwner, scope: KnowledgeScope, input: KnowledgeConversationInput, signal?: AbortSignal): Promise<KnowledgeConversationResult> {
    this.current(owner, signal)
    input = normalize(input)
    const operationId = conversationOperationId(owner, input)
    if (input.kind === 'context') return { operationId, status: 'completed', detail: 'Project workflow context; reference data is not action authorization', context: await this.context(owner, scope, signal) }
    if (input.kind === 'read_task') return { operationId, status: 'completed', detail: 'Current task PRD read for a revision-aware planning handoff', taskPrd: { taskDir: input.taskDir, ...readTaskPrd(owner.root, { expectedRoot: owner.root, taskDir: input.taskDir }) } }
    if (input.kind === 'read_document') {
      const state = readKnowledgeState(owner.root)
      const artifact = state.artifacts.find((item) => item.id === input.artifactId && (!input.revision || item.revision === input.revision))
      if (!artifact) return this.clarify(operationId, 'artifactId', 'Choose a known project document', state.artifacts.slice(0, 20).map((item) => ({ id: item.id, label: item.title })))
      const actual = materialRead(owner.root, artifact.relativePath)
      if (actual.body.length > 200_000) throw new IntegrationError('Current document exceeds the conversational editing limit; the file is preserved', 'io')
      return { operationId, status: 'completed', detail: actual.revision === artifact.revision ? 'Read the exact saved document version' : 'The project file changed externally. Use document.body and document.revision to preserve those edits in a subsequent update.', artifact, document: { ...actual, relativePath: artifact.relativePath, externallyChanged: actual.revision !== artifact.revision } }
    }
    if (!owner.connectionGeneration || typeof owner.originalUserText !== 'string') throw new IntegrationError('No trusted admitted user turn is available for a document action', 'denied')
    const key = `${owner.root}:${operationId}`
    const joined = this.inFlight.get(key)
    if (joined) { const result = await joined; this.assertOwner(owner); return result }
    const operation = this.mutate(owner, scope, input, operationId, signal)
    this.inFlight.set(key, operation)
    try { return await operation } finally { this.inFlight.delete(key) }
  }

  private async context(owner: KnowledgeOwner, scope: KnowledgeScope, signal?: AbortSignal): Promise<KnowledgeConversationContext> {
    const state = readKnowledgeState(owner.root)
    const seen = new Set<string>()
    const versions = state.artifacts.filter((item) => !seen.has(item.id) && !!seen.add(item.id))
    const artifacts = versions.slice(0, 20).map((item) => ({ id: item.id, revision: item.revision, title: item.title, relativePath: item.relativePath, sessionId: item.sessionId, current: materialRead(owner.root, item.relativePath).revision === item.revision }))
    const tasks = this.tasks(owner)
    let collections: { id: string; name: string }[] = []
    let remoteStatus: string = scope.status
    if (scope.collectionIds.length && scope.status === 'ok') {
      try {
        const accessible = await this.host.collections({ expectedRoot: owner.root, sessionId: owner.sessionId })
        collections = accessible.items.filter((item) => scope.collectionIds.includes(item.id)).slice(0, 20).map(({ id, name }) => ({ id, name }))
      } catch { remoteStatus = 'unavailable' }
      this.current(owner, signal)
      this.assertScope(owner, scope)
    }
    return { artifacts, tasks: tasks.slice(0, 30), collections, remoteStatus, boundTaskDir: owner.taskDir ?? null, truncated: versions.length > 20 || tasks.length > 30 }
  }

  private tasks(owner: KnowledgeOwner): KnowledgeConversationContext['tasks'] {
    this.assertOwner(owner)
    return this.taskInventory(owner).slice(0, 100).map((task) => ({ taskDir: task.taskDir, title: task.title, status: task.status, prdRevision: readTaskPrd(owner.root, { expectedRoot: owner.root, taskDir: task.taskDir }).revision }))
  }

  private taskInventory(owner: KnowledgeOwner): { taskDir: string; id: string; title: string; status: string }[] {
    const path = materialPath(owner.root, '.trellis/tasks')
    let directories: string[]
    try { directories = readdirSync(path).slice(0, 1000) } catch { return [] }
    return directories.flatMap((taskDir) => {
      if (taskDir === 'archive') return []
      try {
        const value: unknown = JSON.parse(materialRead(owner.root, `.trellis/tasks/${taskDir}/task.json`).body)
        if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !('title' in value) || typeof value.title !== 'string' || !('status' in value) || typeof value.status !== 'string' || value.status === 'completed') return []
        return [{ taskDir, id: value.id, title: value.title.slice(0, 200), status: value.status.slice(0, 100) }]
      } catch { return [] }
    })
  }

  private clarify(operationId: string, field: NonNullable<KnowledgeConversationResult['clarification']>['field'], detail: string, choices: { id: string; label: string }[] = []): KnowledgeConversationResult {
    return { operationId, status: 'needs_clarification', detail, clarification: { field, choices } }
  }

  private remember(owner: KnowledgeOwner, input: Mutation, operationId: string, artifactId: string, artifactRevision: string, fields: Partial<Action> = {}): Action {
    return updateConversationActions(owner.root, (actions) => {
      const old = actions.find((item) => item.operationId === operationId)
      if (old) return old
      const now = Date.now()
      const origin = turnOrigin(owner)
      const record: Action = { operationId, payloadHash: conversationPayloadHash(input), sessionId: owner.sessionId, turnId: owner.turnId,
        userRequestHash: origin.userRequestHash, connectionGeneration: origin.connectionGeneration, kind: input.kind,
        state: 'pending', createdAt: now, updatedAt: now, artifactId, artifactRevision, detail: 'Action admitted from the native conversation; formal business review is not asserted', ...fields }
      actions.unshift(record)
      return record
    })
  }

  private finish(root: string, operationId: string, fields: Partial<Action>): void {
    updateConversationActions(root, (actions) => {
      const record = actions.find((item) => item.operationId === operationId)
      if (!record) throw new IntegrationError('Conversation action receipt missing', 'io')
      Object.assign(record, fields, { updatedAt: Date.now() })
    })
  }

  private async mutate(owner: KnowledgeOwner, scope: KnowledgeScope, input: Mutation, operationId: string, signal?: AbortSignal): Promise<KnowledgeConversationResult> {
    const old = readConversationActions(owner.root).find((item) => item.operationId === operationId)
    if (old && (old.payloadHash !== conversationPayloadHash(input) || old.sessionId !== owner.sessionId || old.turnId !== owner.turnId)) throw new IntegrationError('Action identity is bound to another payload or turn', 'conflict')
    if (input.kind === 'save_document') return this.save(owner, input, operationId, old, signal)
    const artifact = artifactRead(owner.root, input.artifactId, input.revision)
    if (old?.state === 'completed' && input.kind === 'handoff' && old.taskDir && old.prdRevision) return this.handoffResult(old, artifact)
    // A successful or uncertain publication is a historical fact even if a later file changed.
    if (input.kind === 'publish_document' && old?.publicationId) {
      const publication = readKnowledgeState(owner.root).publications.find((item) => item.requestId === old.publicationId)
      if (publication && publication.state !== 'previewed') {
        if (publication.state === 'pending') {
          const result = await this.host.confirmPublication({ expectedRoot: owner.root, sessionId: owner.sessionId, requestId: publication.requestId })
          return { operationId, status: result.state === 'published' ? 'completed' : result.state === 'failed' ? 'failed' : 'uncertain', detail: result.detail, publication: result }
        }
        return { operationId, status: publication.state === 'published' ? 'completed' : publication.state === 'failed' ? 'failed' : 'uncertain', detail: publication.detail, publication }
      }
    }
    assertArtifactCurrent(owner.root, artifact)
    this.current(owner, signal)
    if (input.kind === 'publish_document') return this.publish(owner, scope, input, artifact, operationId, signal)
    return this.handoff(owner, input, artifact, operationId, old, signal)
  }

  private save(owner: KnowledgeOwner, input: Extract<Mutation, { kind: 'save_document' }>, operationId: string, old: Action | undefined, signal?: AbortSignal): KnowledgeConversationResult {
    const state = readKnowledgeState(owner.root)
    if (old?.state === 'completed') return { operationId, status: 'completed', detail: old.detail, artifact: artifactRead(owner.root, old.artifactId, old.artifactRevision) }
    const previous = input.artifactId ? state.artifacts.find((item) => item.id === input.artifactId) : undefined
    if (input.artifactId && !previous) return this.clarify(operationId, 'artifactId', 'The requested project document is unknown')
    if (previous && !input.expectedRevision) throw new IntegrationError('Read the known document and supply its expectedRevision before updating it', 'conflict')
    const sourceIds = [...new Set(input.sourceIds ?? [])].sort()
    for (const id of sourceIds) if (!state.sources.some((entry) => entry.source.id === id && entry.source.sessionId === owner.sessionId && entry.source.suppliedToAgent)) throw new IntegrationError('Document evidence must be persisted sources actually supplied to this conversation', 'denied')
    const id = old?.artifactId ?? previous?.id ?? randomUUID()
    const path = old?.relativePath ?? previous?.relativePath ?? `.trellis/notes/product-requirements-${id}.md`
    const revision = knowledgeHash(input.body)
    this.current(owner, signal)
    this.remember(owner, input, operationId, id, revision, { relativePath: path })
    let expectedRevision = input.expectedRevision ?? null
    // Recover a crash after file replacement, without overwriting an external edit.
    const actual = materialRead(owner.root, path)
    if (old && actual.revision === revision) expectedRevision = revision
    const artifact = saveKnowledgeArtifact(owner.root, { expectedRoot: owner.root, sessionId: owner.sessionId, turnId: owner.turnId,
      ...(previous ? { id } : {}), expectedRevision, title: input.title, body: input.body, kind: 'product-requirements', sourceIds },
    { id, origin: turnOrigin(owner) })
    this.finish(owner.root, operationId, { state: 'completed', detail: 'Requirements document written from this conversation; unresolved questions remain in the document. Formal business review is not asserted.' })
    return { operationId, status: 'completed', detail: 'Requirements document saved in the project', artifact }
  }

  private async publish(owner: KnowledgeOwner, scope: KnowledgeScope, input: Extract<Mutation, { kind: 'publish_document' }>, artifact: KnowledgeArtifact, operationId: string, signal?: AbortSignal): Promise<KnowledgeConversationResult> {
    this.assertScope(owner, scope)
    const context = await this.context(owner, scope, signal)
    this.current(owner, signal)
    if (context.remoteStatus === 'unavailable') return { operationId, status: 'failed', detail: '知识库暂时无法访问，尚未发起发布。请连接恢复后再试，无需重新绑定知识库。' }
    const target = input.collectionId ? context.collections.find((item) => item.id === input.collectionId) : context.collections.length === 1 ? context.collections[0] : undefined
    if (!target) return this.clarify(operationId, 'collectionId', context.collections.length ? 'Which project knowledge library should receive this document?' : 'The project has no accessible publication destination. Bind a project library before publishing.', context.collections.map((item) => ({ id: item.id, label: item.name })))
    this.remember(owner, input, operationId, artifact.id, artifact.revision, { publicationId: operationId })
    await this.host.previewPublication({ expectedRoot: owner.root, sessionId: owner.sessionId, artifactId: artifact.id, revision: artifact.revision, collectionId: target.id, requestId: operationId })
    this.current(owner, signal)
    this.assertScope(owner, scope)
    // The Agent requested this exact saved payload on behalf of the admitted user turn.
    // Native tool approvals remain in the adapter's existing permission mediator.
    let publication
    try { publication = await this.host.confirmPublication({ expectedRoot: owner.root, sessionId: owner.sessionId, requestId: operationId }) }
    catch (error) {
      const committed = readKnowledgeState(owner.root).publications.find((item) => item.requestId === operationId)
      if (!committed || committed.state === 'previewed') throw error
      publication = committed.state === 'pending' ? { ...committed, state: 'uncertain' as const, detail: 'Publication was attempted; verify the remote outcome before any resend' } : committed
    }
    const status = publication.state === 'published' ? 'completed' : publication.state === 'failed' ? 'failed' : 'uncertain'
    this.finish(owner.root, operationId, { state: status, detail: publication.detail })
    return { operationId, status, detail: publication.detail, publication }
  }

  private handoff(owner: KnowledgeOwner, input: Extract<Mutation, { kind: 'handoff' }>, artifact: KnowledgeArtifact, operationId: string, old: Action | undefined, signal?: AbortSignal): KnowledgeConversationResult {
    if (input.taskDir && input.createTask) throw new IntegrationError('Choose an existing task or a new planning task, not both')
    const tasks = this.tasks(owner)
    let taskDir = old?.taskDir ?? input.taskDir ?? (!input.createTask ? owner.taskDir : undefined)
    let createdTask = old?.createdTask ?? false
    if (!taskDir && !input.createTask && tasks.length) return this.clarify(operationId, 'taskDir', 'Choose an existing developer task, or create a new planning task', [...tasks.slice(0, 30).map((item) => ({ id: item.taskDir, label: item.title })), { id: 'create-new', label: 'New planning task' }])
    const slug = old?.taskSlug ?? `requirements-${operationId.slice(0, 8)}`
    this.current(owner, signal)
    const record = this.remember(owner, input, operationId, artifact.id, artifact.revision, { ...(taskDir ? { taskDir } : { taskSlug: slug }), createdTask: !taskDir })
    if (!taskDir) {
      // A deterministic host slug allows recovery after the synchronous supported creator
      // committed task.json but the conversation receipt was not yet updated.
      const recovered = this.taskInventory(owner).filter((task) => task.id === slug)
      if (recovered.length > 1) throw new IntegrationError('Multiple tasks match this action; inspect them before retrying', 'conflict')
      if (recovered[0]) taskDir = recovered[0].taskDir
      else {
        // Fence the tasks directory before the global-root synchronous writer is entered.
        materialRead(owner.root, `.trellis/tasks/${slug}/task.json`)
        this.current(owner, signal)
        const created = createKnowledgePlanningTask({ dirName: slug, title: input.title ?? artifact.title, description: `Planning from ${artifact.relativePath}`, status: 'planning', priority: 'P2', assignee: '', origin: 'plan' })
        if (!created.ok) throw new IntegrationError(created.error, 'io')
        taskDir = created.dirName
      }
      createdTask = true
      this.finish(owner.root, operationId, { taskDir, createdTask: true })
    }
    const actual = readTaskPrd(owner.root, { expectedRoot: owner.root, taskDir })
    const plannedBody = `> Product requirements: ${artifact.relativePath}\n> Product revision (sha256): ${artifact.revision}\n> Handoff records source only; it does not authorize implementation.\n\n${input.developerBody}`
    const plannedRevision = knowledgeHash(plannedBody)
    if (!createdTask && input.expectedPrdRevision === undefined && actual.revision !== plannedRevision) throw new IntegrationError('Read the existing task PRD and pass expectedPrdRevision; user edits must be preserved', 'conflict')
    this.current(owner, signal)
    const handoff = handoffKnowledgeArtifact(owner.root, { expectedRoot: owner.root, sessionId: owner.sessionId, artifactId: artifact.id, revision: artifact.revision, taskDir,
      developerBody: input.developerBody, expectedPrdRevision: old && actual.revision === plannedRevision ? plannedRevision : createdTask ? null : input.expectedPrdRevision ?? null })
    this.finish(owner.root, operationId, { state: 'completed', taskDir, createdTask, prdRevision: handoff.prdRevision, detail: 'Developer PRD saved with the product document backlink. Implementation has not started.' })
    return this.handoffResult({ ...record, ...handoff, prdRevision: handoff.prdRevision, taskDir, createdTask }, artifact)
  }

  private handoffResult(record: Action, artifact: KnowledgeArtifact): KnowledgeConversationResult {
    if (!record.taskDir || !record.prdRevision) throw new IntegrationError('The developer handoff receipt is incomplete; inspect project material before retrying', 'io')
    return { operationId: record.operationId, status: 'completed', detail: 'Developer planning handoff saved; implementation has not started', artifact,
      handoff: { taskDir: record.taskDir, prdRevision: record.prdRevision, productPath: artifact.relativePath, productRevision: artifact.revision, createdTask: !!record.createdTask, status: record.createdTask ? 'planning' : 'existing', codingStarted: false } }
  }
}
