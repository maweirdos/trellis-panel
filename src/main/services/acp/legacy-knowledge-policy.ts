import type { AcpSessionRecord } from 'acpx/runtime'
import { KNOWLEDGE_CONVERSATION_INSTRUCTIONS } from '../knowledge-mcp/instructions'

const LEGACY_HOST_POLICY = 'Project knowledge and requirements workflow:\nFor text questions with selected project libraries, the host performs a bounded first lookup before this native turn.'

/** Replace only this host's recognized obsolete append, preserving the frozen role. */
export function upgradeLegacyKnowledgePolicy(record: AcpSessionRecord | undefined, instructions = ''): AcpSessionRecord | undefined {
  const prompt = record?.acpx?.session_options?.system_prompt
  if (!record?.acpx?.session_options || typeof prompt !== 'object' || prompt === null || typeof prompt.append !== 'string') return record
  const prefix = instructions ? `${instructions}\n\n` : ''
  if (!prompt.append.startsWith(prefix + LEGACY_HOST_POLICY)) return record
  return { ...record, acpx: { ...record.acpx, session_options: { ...record.acpx.session_options,
    system_prompt: { append: [instructions, KNOWLEDGE_CONVERSATION_INSTRUCTIONS].filter(Boolean).join('\n\n') } } } }
}
