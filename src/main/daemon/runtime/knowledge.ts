import { knowledgeRuntimeInputs, knowledgeRuntimeBody } from '../../../shared/daemon-runtime-knowledge'
import { knowledgeAccess } from '../../services/knowledge-access/service'
import { withKnowledgeOwner } from '../../services/knowledge-access/workspace-host'
import { canonicalDirectory } from '../../services/acp/metadata'
import { DaemonError } from '../errors'
import type { KnowledgeOwner } from '../../services/knowledge-access/types'

/** GUI and MCP share the same knowledge service, scopes and publication in-flight authority. */
export function createRuntimeKnowledge(current: () => boolean): { execute(root: string, generation: number, raw: unknown): Promise<unknown>; stopReads(): void } {
  const reads = new Map<string, AbortController>()
  return {
    stopReads() { for (const controller of reads.values()) controller.abort() },
    async execute(root, generation, raw) {
      const body = knowledgeRuntimeBody.parse(raw)
      const parsed = knowledgeRuntimeInputs[body.operation].parse(body.input)
      if (canonicalDirectory(parsed.expectedRoot) !== canonicalDirectory(root)) throw new DaemonError('E_DENIED', 'Knowledge request does not match its authenticated workspace.')
      const input = { ...parsed, expectedRoot: root }
      const owner: KnowledgeOwner = { root, projectGeneration: generation, sessionId: input.sessionId ?? 'ui', turnId: 'requestId' in input ? `ui-${input.requestId}` : 'ui-context', isCurrent: current }
      return withKnowledgeOwner(owner, async () => {
        // The explicit adapter list is the complete capability; there is no object reflection.
        switch (body.operation) {
          case 'search': case 'read': {
            const request = body.operation === 'search' ? knowledgeRuntimeInputs.search.parse(input) : knowledgeRuntimeInputs.read.parse(input)
            const key = `${root}:${body.readerId}:${request.requestId}`
            if (reads.has(key) || reads.size >= 32) throw new DaemonError('E_BUSY', 'Knowledge read concurrency reached its bound.')
            const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 30_000)
            reads.set(key, abort)
            try {
              const scope = knowledgeAccess.capture(owner)
              return body.operation === 'search' ? await knowledgeAccess.search(owner, scope, knowledgeRuntimeInputs.search.parse(input), abort.signal) : await knowledgeAccess.read(owner, scope, knowledgeRuntimeInputs.read.parse(input), abort.signal)
            } finally { clearTimeout(timer); reads.delete(key) }
          }
          case 'cancel': { const p = knowledgeRuntimeInputs.cancel.parse(input); reads.get(`${root}:${body.readerId}:${p.requestId}`)?.abort(); return null }
          case 'context': return knowledgeAccess.context(knowledgeRuntimeInputs.context.parse(input))
          case 'collections': return knowledgeAccess.collections(knowledgeRuntimeInputs.collections.parse(input))
          case 'updateScope': return knowledgeAccess.updateScope(knowledgeRuntimeInputs.updateScope.parse(input))
          case 'documents': return knowledgeAccess.documents(knowledgeRuntimeInputs.documents.parse(input))
          case 'source': return knowledgeAccess.source(knowledgeRuntimeInputs.source.parse(input))
          case 'sources': return knowledgeAccess.sources(knowledgeRuntimeInputs.sources.parse(input))
          case 'importLegacy': return knowledgeAccess.importLegacy(knowledgeRuntimeInputs.importLegacy.parse(input))
          case 'saveArtifact': return knowledgeAccess.saveArtifact(knowledgeRuntimeInputs.saveArtifact.parse(input))
          case 'artifacts': return knowledgeAccess.artifacts(knowledgeRuntimeInputs.artifacts.parse(input))
          case 'artifact': return knowledgeAccess.artifact(knowledgeRuntimeInputs.artifact.parse(input))
          case 'taskPrd': return knowledgeAccess.taskPrd(knowledgeRuntimeInputs.taskPrd.parse(input))
          case 'handoff': return knowledgeAccess.handoff(knowledgeRuntimeInputs.handoff.parse(input))
          case 'previewPublication': return knowledgeAccess.previewPublication(knowledgeRuntimeInputs.previewPublication.parse(input))
          case 'confirmPublication': return knowledgeAccess.confirmPublication(knowledgeRuntimeInputs.confirmPublication.parse(input))
          case 'publications': return knowledgeAccess.publications(knowledgeRuntimeInputs.publications.parse(input))
          case 'publicationPage': return knowledgeAccess.publicationPage(knowledgeRuntimeInputs.publicationPage.parse(input))
          case 'resolvePublication': return knowledgeAccess.resolvePublication(knowledgeRuntimeInputs.resolvePublication.parse(input))
          case 'clearHistory': return knowledgeAccess.clearHistory(knowledgeRuntimeInputs.clearHistory.parse(input))
        }
      })
    }
  }
}
