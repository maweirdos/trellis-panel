import { KnowledgeMcpBridge } from './server'
import type { KnowledgeMcpIdentity, KnowledgeMcpObservation } from './server'
import { withKnowledgeOwner } from '../knowledge-access/workspace-host'

let bridge: KnowledgeMcpBridge | undefined

// ACP is a leaf at bootstrap. Resolve the application service only once a user
// opens a native connection, after main project state has initialized.
export const knowledgeMcpBridge = {
  async connect(identity: KnowledgeMcpIdentity, observe: (observation: KnowledgeMcpObservation) => void) {
    if (!bridge) {
      const { knowledgeAccess } = await import('../knowledge-access/service')
      bridge ??= new KnowledgeMcpBridge({
        capture: owner => withKnowledgeOwner(owner, () => knowledgeAccess.capture(owner)),
        search: (owner, scope, input, signal) => withKnowledgeOwner(owner, () => knowledgeAccess.search(owner, scope, input, signal)),
        read: (owner, scope, input, signal) => withKnowledgeOwner(owner, () => knowledgeAccess.read(owner, scope, input, signal)),
        markSupplied: (owner, sourceIds) => withKnowledgeOwner(owner, () => knowledgeAccess.markSupplied(owner, sourceIds)),
        conversation: (owner, scope, input, signal) => withKnowledgeOwner(owner, () => knowledgeAccess.conversation(owner, scope, input, signal))
      })
    }
    return bridge.connect(identity, observe)
  },
  redactText(text: string): string { return bridge?.redactText(text) ?? text },
  redact<T>(value: T): T { return bridge?.redact(value) ?? value },
  async close(): Promise<void> { await bridge?.close() }
}
export type { KnowledgeMcpConnection, KnowledgeMcpObservation } from './server'
