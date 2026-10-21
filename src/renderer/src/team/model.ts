import type { TeamDesktopReply } from '../../../shared/team-desktop-bridge'
import type { DesktopTeamConnection, DesktopTeamDocument, DesktopTeamOutbox } from '../../../shared/team-desktop'
import { teamPublishedDocumentSchema, TEAM_MAX_DOCUMENT_BYTES } from '../../../shared/team-platform'

export class TeamUiError extends Error {
  constructor(readonly code: string, message: string, readonly outcomeUnknown = false) { super(message); this.name = 'TeamUiError' }
}
export function valueOf<T>(reply: TeamDesktopReply<T>): T { if (!reply.ok) throw new TeamUiError(reply.code, reply.error, reply.outcomeUnknown); return reply.value }
export const errorText = (error: unknown): string => error instanceof Error ? error.message : '暂时无法完成，请保留原操作并核对状态。'
export const denied = (error: unknown): boolean => error instanceof TeamUiError && ['UNAUTHENTICATED', 'UNAUTHORIZED', 'FORBIDDEN', 'DEVICE_REVOKED', 'ACCOUNT_DISABLED', 'AUTHENTICATION_REQUIRED', 'ACCESS_LOCKED', 'BINDING_CHANGED'].includes(error.code)
export const visibilityLabel = (value: string): string => ({ personal: '仅自己', project: '项目成员', team: '团队成员' })[value] ?? value
export const kindLabel = (value: string): string => ({ 'product-requirement': '产品需求', 'trellis-prd': '开发需求 PRD', design: '技术设计', spec: '规范', code: '代码材料', feedback: '反馈', other: '其他文档' })[value] ?? value
export const roleLabel = (value: string): string => ({ product: '产品', pm: '项目经理', developer: '开发', tester: '测试', admin: '项目管理' })[value] ?? value
export const connectionLabel = (value: DesktopTeamConnection): string => value.accessLocked ? '访问已锁定' : ({ pending: '待浏览器确认', active: '已授权', revoked: '授权已撤销', expired: '配对已到期', disconnected: '已在本机断开' })[value.state]
export function outboxLabel(value: DesktopTeamOutbox): string {
  if (value.state === 'access-revoked' && value.outcomeUnknown) return '访问已撤销 · 原发送结果仍待核对'
  return ({ queued: '已保存，等待发送', dispatching: '已派发，等待确认', 'acknowledgement-unknown': '结果未确认', committed: value.kind === 'feedback' ? '反馈已记录' : '已发布', conflict: '版本或内容冲突', 'access-revoked': '访问已撤销', 'cancelled-before-dispatch': '发送前已取消' })[value.state]
}
export const timeLabel = (value: number | null): string => value === null ? '尚无记录' : new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
export function exactQuote(text: string, quote: string): { quote: string; anchor?: { start: number; end: number } } {
  if (!quote) return { quote: '' }
  const start = text.indexOf(quote)
  if (start < 0) throw new TeamUiError('QUOTE_MISMATCH', '引用文字不在当前固定版本中，请重新选择。')
  return start === text.lastIndexOf(quote) ? { quote, anchor: { start, end: start + quote.length } } : { quote }
}
export async function verifyDocument(value: DesktopTeamDocument): Promise<DesktopTeamDocument> {
  const document = teamPublishedDocumentSchema.parse(value.document), bytes = new TextEncoder().encode(document.text)
  if (bytes.byteLength !== document.material.byteLength || bytes.byteLength > TEAM_MAX_DOCUMENT_BYTES) throw new TeamUiError('BODY_MISMATCH', '固定版本长度不一致，未替换正在阅读的内容。')
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((item) => item.toString(16).padStart(2, '0')).join('')
  if (digest !== document.material.bodyDigest) throw new TeamUiError('BODY_MISMATCH', '固定版本摘要不一致，未展示未经核实的正文。')
  if (!['remote', 'cached-offline'].includes(value.freshness) || !['current-server', 'last-observed'].includes(value.authorization)) throw new TeamUiError('INVALID_RESPONSE', '文档来源状态无效。')
  if ((value.freshness === 'cached-offline') !== (value.authorization === 'last-observed')) throw new TeamUiError('INVALID_RESPONSE', '缓存与授权核验状态不一致。')
  return { ...value, document }
}

export type SavedIntent = { version: 1; commandId: string; connectionId: string; materialId: string; kind: 'publication' | 'feedback'; digest: string; createdAt: number }
const storagePrefix = 'tpanel.team.pending-intents.v1:'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function readIntents(): SavedIntent[] {
  if (localStorage.length > 4096) throw new TeamUiError('INTENT_STORAGE', '本地索引超出检查限界，未创建替代操作。')
  let parsed: unknown[]
  try { parsed = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key): key is string => key !== null && key.startsWith(storagePrefix)).map((key) => { const row = JSON.parse(localStorage.getItem(key) ?? 'null'); if (key !== storagePrefix + row?.commandId) throw Error('Mismatched intent identity'); return row }) } catch { throw new TeamUiError('INTENT_STORAGE', '本地操作索引损坏，原记录已保留；请先核对，不会创建替代身份。') }
  if (!Array.isArray(parsed) || parsed.length > 64 || parsed.some((row: unknown) => {
    if (!row || typeof row !== 'object') return true
    const value = row as Partial<SavedIntent>
    return Object.keys(row).sort().join(',') !== 'commandId,connectionId,createdAt,digest,kind,materialId,version' || value.version !== 1 || !uuid.test(value.commandId ?? '') || !uuid.test(value.connectionId ?? '') || !uuid.test(value.materialId ?? '') || !['publication', 'feedback'].includes(value.kind ?? '') || !/^[0-9a-f]{64}$/.test(value.digest ?? '') || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0
  }) || new Set(parsed.map((row) => (row as SavedIntent).commandId)).size !== parsed.length) throw new TeamUiError('INTENT_STORAGE', '本地操作索引无法核实，原记录已保留。')
  return parsed as SavedIntent[]
}
export function saveIntent(value: SavedIntent): void {
  const all = readIntents(), old = all.find((entry) => entry.commandId === value.commandId)
  if (old && JSON.stringify(old) !== JSON.stringify(value)) throw new TeamUiError('INTENT_CONFLICT', '原操作身份已改变，不能覆盖。')
  if (!old && all.length >= 64) throw new TeamUiError('INTENT_STORAGE', '待核对操作已达限界，请先核对已有记录。')
  try { localStorage.setItem(storagePrefix + value.commandId, JSON.stringify(value)) } catch { throw new TeamUiError('INTENT_STORAGE', '无法保存原操作标识，尚未请求发布。') }
}
export function clearIntent(value: SavedIntent): void {
  const all = readIntents(), old = all.find((entry) => entry.commandId === value.commandId)
  if (!old || JSON.stringify(old) !== JSON.stringify(value)) return
  localStorage.removeItem(storagePrefix + value.commandId)
}
export async function intentDigest(payload: unknown): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload))))].map((item) => item.toString(16).padStart(2, '0')).join('') }
