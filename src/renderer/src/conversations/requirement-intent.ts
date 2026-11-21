import { requirementCreateSchema, type RequirementFileSelection } from '@shared/conversation-requirements'
import { replayConversationTextEvents } from '@shared/acp-text-blocks'
import type { WorkspaceEntry } from './workspace'

export interface RequirementSeed {
  sourceKey: string
  text: string
  initialDocument?: { fileId: string; revision: string }
  references: RequirementFileSelection[]
}

export async function requirementIntentCommandId(owner: string, conversationId: string, seed: RequirementSeed): Promise<string> {
  const identity = JSON.stringify(['requirement-intent-v1', owner, conversationId, seed.initialDocument ?? seed.text, seed.references])
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))).slice(0, 16)
  bytes[6] = bytes[6] & 0x0f | 0x40; bytes[8] = bytes[8] & 0x3f | 0x80
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function literalText(text: string): string {
  return text.normalize('NFKC').replace(/```[\s\S]*?(?:```|$)/g, '').split('\n').filter(line => !/^\s*>/.test(line)).join(' ').trim()
}
function declinesRequirement(text: string): boolean {
  return /(?:不要|不用|别)(?:帮我)?(?:创建|新建|整理|讨论).{0,8}需求|换个话题|不讨论.{0,6}需求/.test(text)
}
function describesRequirement(text: string): boolean {
  if (/^(?:怎么|如何|为什么|举例|示例|解释|what\b|how\b)/i.test(text)) return false
  const action = /(?:我(?:要|想)(?:做|开发|建|设计)|帮我(?:做|开发|整理|设计)|(?:制定|起草|编写|生成|形成|整理|讨论|梳理|细化|明确|完善).{0,16}(?:需求|业务)|(?:新建|发布|创建).{0,8}需求|设计一版|\b(?:build|create|design)\b)/i.test(text)
  return action && /需求|业务|功能|系统|平台|应用|小程序|接口|交互|页面|项目|产品|\b(?:app|website|feature|requirements?|prototype)\b/i.test(text)
}
export function requirementIntent(entry: WorkspaceEntry | undefined): RequirementSeed | undefined {
  if (!entry || entry.locked || entry.conversation?.archivedAt !== undefined) return
  const context = entry.discussion?.events ?? replayConversationTextEvents(entry.events)
  const users = context.filter(event => event.kind === 'message' && event.payload?.role === 'user' && event.text?.trim())
  const seen = new Set(users.map(event => event.id))
  const liveUsers = entry.events.filter(event => event.kind === 'message' && event.payload?.role === 'user' && event.text?.trim() && !seen.has(event.id))
  const messages = [...users, ...liveUsers].map(event => event.text!.trim())
  const pending = entry.text.trim() || entry.submission?.draftText
  if (pending && pending !== messages.at(-1)) messages.push(pending)
  const latest = literalText(messages.at(-1) ?? '')
  if (!latest || declinesRequirement(latest)) return
  let start = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    const literal = literalText(messages[index])
    if (declinesRequirement(literal)) break
    if (describesRequirement(literal)) start = index
  }
  if (start < 0 || !describesRequirement(latest) && /^(?:hi|hello|你好|谢谢|早上好|晚安|再见)[!！。\s]*$/i.test(latest)) return
  const contextStart = context.findIndex(event => event.payload?.role === 'user' && event.text?.trim() === messages[start])
  const discussion = context.slice(Math.max(0, contextStart)).filter(event => event.kind === 'message' && event.text?.trim()).map(event => `${event.payload?.role === 'user' ? '用户' : '助手提问或建议'}：${event.text}`).join('\n\n')
  const text = ((entry.discussion?.truncated ? '语境只包含原始入口和近期讨论，完整历史仍保留。\n\n' : '') + (entry.discussion ? discussion + '\n\n' + messages.slice(start).filter(message => !users.some(user => user.text?.trim() === message)).map(message => `用户：${message}`).join('\n\n') : messages.slice(start).join('\n\n'))).slice(0, 60_000)
  const references = requirementCreateSchema.shape.references.safeParse(entry.files.filter(file => file.kind === 'input').map(file => ({ fileId: file.id, revision: file.revision })))
  if (!references.success) return
  const explicitMessage = [...users, ...liveUsers].reverse().find(event => /(?:制定|起草|编写|生成|形成|整理).{0,12}需求/.test(literalText(event.text ?? '')))
  const requestMessage = explicitMessage ?? [...users, ...liveUsers].find(event => event.text?.trim() === messages[start])
  const responses = [...context, ...replayConversationTextEvents(entry.events)].filter(event => event.kind === 'message' && event.payload?.role !== 'user' && event.text && (!requestMessage || event.ts >= requestMessage.ts))
  const document = entry.files.filter(file => file.kind === 'output' && /\.md$/i.test(file.name) && /需求|requirements?/i.test(file.name) && responses.some(event => {
    let text = event.text ?? ''
    try { text = decodeURIComponent(text) } catch { /* Plain text remains available for an exact path match. */ }
    return text.replaceAll('\\', '/').includes(file.relativePath.replaceAll('\\', '/'))
  })).sort((left, right) => right.modifiedAt - left.modifiedAt)[0]
  const initialDocument = document ? { fileId: document.id, revision: document.revision } : undefined
  if (initialDocument && !references.data.some(reference => reference.fileId === initialDocument.fileId)) references.data.push(initialDocument)
  const explicit = /(?:制定|起草|编写|生成|形成|整理).{0,12}需求/.test(latest)
  const explicitKey = pending && explicit ? `draft:${latest}` : explicitMessage?.id ?? ''
  return { sourceKey: JSON.stringify([entry.owner, entry.key, messages[start], explicitKey, references.data, initialDocument]), text, references: references.data, initialDocument }
}
