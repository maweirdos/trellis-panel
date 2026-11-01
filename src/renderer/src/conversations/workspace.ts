import { create } from 'zustand'
import type { AcpHistoryEventPage } from '@shared/acp-history'
import type { Conversation, ConversationContext, ConversationContextChoice, ConversationDirectoryGrant, ConversationFile, ConversationProject, ConversationRead } from '@shared/private-conversations'
import type { AcpAgentStatus, AcpPermissionPayload, AcpSessionRecord, ChatSessionMeta, ChatSessionView, TimelineEvent } from '@shared/types'
import type { AcpImageAttachment } from '@shared/acp-images'
import type { CurrentTurnRequest } from '../acp/current-turn-activity'
import { mergeEvents } from '../acp/timeline'
import { api, hasIpc } from '../api'
import { projectRootKey } from '../my/navigation'
import { useHifox } from '../hifox/store'
import { conversationClient, conversationError, conversationValue } from './client'
import { installationNamespace, readStoredWorkspace, writeStoredWorkspace, type StoredWorkspace } from './draft-storage'

export const PERSONAL: ConversationContext = { kind: 'personal' }
export type ConversationKind = Conversation['kind']
export const contextKey = (context: ConversationContext): string => context.kind === 'personal' ? 'personal' : JSON.stringify([context.workspaceKey, context.spaceId])
export const baseScopeKey = (context: ConversationContext, kind: ConversationKind): string => `${kind}:${contextKey(context)}`
export const scopeKey = (context: ConversationContext, kind: ConversationKind, projectId?: string): string => `${baseScopeKey(context, kind)}:${projectId ?? ''}`

export interface WorkspaceEntry {
  key: string
  owner?: string
  locked?: boolean
  localUpdatedAt?: number
  kind: ConversationKind
  context: ConversationContext
  projectId?: string
  conversation?: Conversation
  directory?: ConversationDirectoryGrant
  text: string
  images?: AcpImageAttachment[]
  imageVersion?: number
  runtimeId?: string
  version: number
  savedVersion: number
  session?: AcpSessionRecord
  events: TimelineEvent[]
  page?: AcpHistoryEventPage | null
  files: ConversationFile[]
  filesLoaded?: boolean
  filesLoading?: boolean
  loaded: boolean
  loading?: boolean
  earlierLoading?: boolean
  error?: string
  loadError?: string
  saveError?: string
  fileError?: string
  nativeError?: string
  action?: 'sending' | 'cancel' | 'end' | 'files' | 'directory' | 'classify' | 'configure' | 'recover-model'
  submission?: { id: string; version: number; text: string }
  request?: CurrentTurnRequest
  permissionPending: Record<string, boolean>
  permissionErrors: Record<string, string>
  scrollTop?: number
  following?: boolean
  composerFocus?: string
}
interface ConversationWorkspace {
  entries: Record<string, WorkspaceEntry>
  selected: Record<string, string>
  projectScopes: Record<string, string | null>
  context: ConversationContext
  conversations: Conversation[]
  projects: ConversationProject[]
  contexts: ConversationContextChoice[]
  runtimes: AcpAgentStatus[]
  defaultRuntimeId?: string
  configuredPi: boolean
  modelLabel?: string
  archives: ChatSessionMeta[]
  archiveReads: Record<string, { loading?: boolean; value?: ChatSessionView; error?: string; branchId?: string }>
  loading: boolean
  initialized: boolean
  error?: string
  runtimeError?: string
  archiveError?: string
  storageError?: string
}
export const useConversations = create<ConversationWorkspace>(() => ({
  entries: {}, selected: {}, projectScopes: {}, context: PERSONAL, conversations: [], projects: [],
  contexts: [{ context: PERSONAL, name: '个人' }], runtimes: [], configuredPi: false,
  archives: [], archiveReads: {}, loading: false, initialized: false
}))
let nativeNamespace = '', authorityRevision = 0, restoringStorage = false
const restoredOwners = new Set<string>(), preservedSnapshots = new Map<string, StoredWorkspace>()
const unreadableStorage = new Map<string, string>()
function storageOwner(context: ConversationContext): string | undefined {
  if (!nativeNamespace) return undefined
  if (context.kind === 'personal') return nativeNamespace
  const source = useHifox.getState().workspaceContext
  return source.key === context.workspaceKey && source.state === 'connected' && source.actorId && source.instanceId
    ? `${nativeNamespace}:team:${JSON.stringify([source.key, source.instanceId, source.origin, source.actorId])}` : undefined
}
function persistLocalDrafts(): void {
  if (!nativeNamespace || restoringStorage) return
  const state = useConversations.getState(), owners = new Set(Object.values(state.entries).flatMap((item) => item.owner ? [item.owner] : []))
  owners.add(nativeNamespace)
  try {
    for (const owner of owners) {
      if (unreadableStorage.has(owner)) continue
      const current = Object.values(state.entries).filter((item) => item.owner === owner && (item.conversation || item.text || Object.values(state.selected).includes(item.key)))
      const previous = preservedSnapshots.get(owner)
      const byKey = new Map((previous?.entries ?? []).map((item) => [item.key, item]))
      for (const item of current) byKey.set(item.key, {
        key: item.key, conversationId: item.conversation?.id, kind: item.kind, context: item.context,
        projectId: item.projectId, text: item.text, runtimeId: item.runtimeId,
        dirty: item.version !== item.savedVersion, updatedAt: item.localUpdatedAt ?? item.conversation?.updatedAt ?? Date.now()
      })
      const selectedKeys = new Set(Object.values(state.selected))
      const values = [...byKey.values()].filter((item) => item.conversationId ? item.dirty || selectedKeys.has(item.key) : Boolean(item.text))
      if (values.length > 40) throw new Error('本机草稿缓存已达到 40 条上限，请先保存未选择目录的 Code 草稿。')
      const keys = new Set(values.map((item) => item.key)), bases = new Set(values.map((item) => baseScopeKey(item.context, item.kind)))
      const snapshot: StoredWorkspace = {
        version: 1, entries: values,
        selected: Object.fromEntries(Object.entries(state.selected).filter(([, key]) => keys.has(key))),
        projects: Object.fromEntries(Object.entries(state.projectScopes).filter(([key]) => bases.has(key))),
        context: storageOwner(state.context) === owner ? state.context : undefined
      }
      writeStoredWorkspace(owner, snapshot); preservedSnapshots.set(owner, snapshot)
    }
    const unreadable = unreadableStorage.values().next().value
    if (unreadable) useConversations.setState({ storageError: unreadable })
    else if (state.storageError) useConversations.setState({ storageError: undefined })
  } catch (cause) { useConversations.setState({ storageError: conversationError(cause) }) }
}
function restoreLocalDrafts(): void {
  const state = useConversations.getState()
  const restoreSelection = Object.values(state.entries).every((item) => !item.text && !item.action && !item.conversation)
  const owners = new Set(state.contexts.flatMap((choice) => { const owner = storageOwner(choice.context); return owner ? [owner] : [] }))
  for (const owner of owners) {
    if (restoredOwners.has(owner)) continue
    restoredOwners.add(owner)
    try {
      const saved = readStoredWorkspace(owner)
      if (!saved) continue
      preservedSnapshots.set(owner, saved)
      const restored: Record<string, WorkspaceEntry> = {}
      for (const item of saved.entries) {
        if (storageOwner(item.context) !== owner || !state.contexts.some((choice) => contextKey(choice.context) === contextKey(item.context))) continue
        if (item.projectId && !state.projects.some((project) => project.id === item.projectId && contextKey(project.context) === contextKey(item.context))) continue
        const conversation = item.conversationId ? state.conversations.find((candidate) => candidate.id === item.conversationId && candidate.kind === item.kind && contextKey(candidate.context) === contextKey(item.context)) : undefined
        if (item.conversationId && !conversation) continue
        if (state.entries[item.key]?.text || item.conversationId && Object.values(state.entries).some((value) => value.conversation?.id === item.conversationId && value.version > 0)) continue
        restored[item.key] = {
          key: item.key, owner, localUpdatedAt: item.updatedAt, conversation, kind: item.kind, context: item.context, projectId: item.projectId,
          text: item.dirty || !conversation ? item.text : '', runtimeId: item.runtimeId ?? state.defaultRuntimeId,
          version: item.dirty ? 1 : 0, savedVersion: item.dirty ? -1 : 0, events: [], files: [], loaded: !conversation,
          permissionPending: {}, permissionErrors: {}
        }
      }
      useConversations.setState((latest) => {
        const selected = { ...latest.selected }
        for (const [scope, key] of Object.entries(saved.selected)) {
          const existing = latest.entries[selected[scope] ?? '']
          if (restored[key] && (!existing || !existing.text && !existing.conversation && !existing.action)) selected[scope] = key
        }
        const restoredContext = saved.context
        return { entries: { ...latest.entries, ...restored }, selected, projectScopes: restoreSelection ? { ...latest.projectScopes, ...saved.projects } : latest.projectScopes,
          ...(restoreSelection && restoredContext && storageOwner(restoredContext) === owner && latest.contexts.some((choice) => contextKey(choice.context) === contextKey(restoredContext)) ? { context: restoredContext } : {}) }
      })
      for (const item of Object.values(restored)) if (item.version !== item.savedVersion) queueSave(item.key)
    } catch (cause) { const error = conversationError(cause); unreadableStorage.set(owner, error); useConversations.setState({ storageError: error }) }
  }
}
let localFingerprint = ''
useConversations.subscribe((state) => {
  const fingerprint = JSON.stringify([state.selected, state.projectScopes, state.context, Object.values(state.entries).map((item) => [item.key, item.owner, item.version, item.savedVersion, item.projectId, item.conversation?.id, item.locked])])
  if (fingerprint === localFingerprint) return
  localFingerprint = fingerprint; persistLocalDrafts()
})
function authorityIdentity(): string {
  const value = useHifox.getState().workspaceContext
  return JSON.stringify([value.key, value.actorId, value.instanceId, value.origin, value.epoch, value.authorizationRevision, value.state])
}
let lastAuthority = authorityIdentity()
useHifox.subscribe(() => {
  const next = authorityIdentity()
  if (next === lastAuthority) return
  lastAuthority = next; authorityRevision++
  persistLocalDrafts()
  useConversations.setState((state) => ({
    context: PERSONAL,
    entries: Object.fromEntries(Object.entries(state.entries).map(([key, value]) => [key, value.context.kind === 'team' ? { ...value, locked: true, session: undefined, events: [], request: undefined, loaded: false } : value])),
    selected: Object.fromEntries(Object.entries(state.selected).filter(([, key]) => state.entries[key]?.context.kind !== 'team')),
    contexts: [{ context: PERSONAL, name: '个人' }], conversations: state.conversations.filter((item) => item.context.kind === 'personal'), projects: state.projects.filter((item) => item.context.kind === 'personal')
  }))
  if (useConversations.getState().initialized) {
    if (refreshing) void refreshing.finally(() => refreshWorkspace())
    else void refreshWorkspace()
  }
})
const entry = (key: string): WorkspaceEntry | undefined => { const value = useConversations.getState().entries[key]; return value?.locked ? undefined : value }
export function patchEntry(key: string, update: Partial<WorkspaceEntry> | ((previous: WorkspaceEntry) => Partial<WorkspaceEntry>)): void {
  useConversations.setState((state) => {
    const previous = state.entries[key]
    return previous && !previous.locked ? { entries: { ...state.entries, [key]: { ...previous, ...(typeof update === 'function' ? update(previous) : update) } } } : state
  })
}
function keepConversation(conversation: Conversation): void {
  useConversations.setState((state) => ({ conversations: [conversation, ...state.conversations.filter((item) => item.id !== conversation.id)].sort((a, b) => b.updatedAt - a.updatedAt) }))
}
function ownsSession(record: { projectRoot?: string; sessionId?: string }, conversation: Conversation): boolean {
  return Boolean(conversation.nativeRef && record.sessionId === conversation.nativeRef.sessionId && projectRootKey(record.projectRoot) === projectRootKey(conversation.workspace.root))
}
function newerSession(previous: AcpSessionRecord | undefined, next: AcpSessionRecord): AcpSessionRecord {
  return previous && (previous.stateRevision ?? 0) > (next.stateRevision ?? 0) ? previous : next
}
function acceptRead(key: string, read: ConversationRead, loadDraft = false): void {
  const previous = entry(key)
  if (!previous || previous.kind !== read.conversation.kind || contextKey(previous.context) !== contextKey(read.conversation.context)) return
  if (previous.conversation && previous.conversation.id !== read.conversation.id) return
  if (previous.conversation && projectRootKey(previous.conversation.workspace.root) !== projectRootKey(read.conversation.workspace.root) && projectRootKey(previous.directory?.path) !== projectRootKey(read.conversation.workspace.root)) return
  if (previous.conversation?.nativeRef && (!read.conversation.nativeRef || previous.conversation.nativeRef.sessionId !== read.conversation.nativeRef.sessionId || projectRootKey(previous.conversation.workspace.root) !== projectRootKey(read.conversation.workspace.root))) return
  if (read.session && !ownsSession(read.session, read.conversation)) throw new Error('会话来源不匹配，请重新打开。')
  patchEntry(key, (current) => ({
    ...(current.conversation && current.conversation.updatedAt > read.conversation.updatedAt ? {} : { conversation: read.conversation, projectId: read.conversation.projectId }),
    ...(loadDraft && current.version === 0 ? { text: read.draft.text, runtimeId: read.draft.runtimeId ?? current.runtimeId, savedVersion: 0 } : {}),
    nativeError: read.runtimeError,
    ...(read.session && !(current.action === 'recover-model' && current.session?.connectionGeneration !== read.session.connectionGeneration) ? { session: newerSession(current.session, read.session) } : {})
  }))
  const accepted = entry(key)?.conversation
  if (accepted) keepConversation(accepted)
}

export function ensureScope(context: ConversationContext, kind: ConversationKind, projectId?: string): string {
  const scope = scopeKey(context, kind, projectId), state = useConversations.getState(), selected = state.selected[scope]
  return selected && (selected.startsWith('archive:') || entry(selected)) ? selected : newDraft(context, kind, projectId)
}
export function newDraft(context: ConversationContext, kind: ConversationKind, projectId?: string, directory?: ConversationDirectoryGrant): string {
  const state = useConversations.getState(), scope = scopeKey(context, kind, projectId)
  const pristine = Object.values(state.entries).find((item) => !item.locked && !item.conversation && item.kind === kind && contextKey(item.context) === contextKey(context) && item.projectId === projectId && !item.text && !item.images?.length && !item.directory && !item.action)
  const key = pristine?.key ?? `draft:${crypto.randomUUID()}`
  const value: WorkspaceEntry = pristine ? { ...pristine, directory, composerFocus: crypto.randomUUID() } : {
    key, owner: storageOwner(context), localUpdatedAt: Date.now(), kind, context, projectId, directory, text: '', runtimeId: state.defaultRuntimeId,
    version: 0, savedVersion: -1, events: [], files: [], loaded: true, permissionPending: {}, permissionErrors: {}, composerFocus: crypto.randomUUID()
  }
  useConversations.setState({ entries: { ...state.entries, [key]: value }, selected: { ...state.selected, [scope]: key }, projectScopes: { ...state.projectScopes, [baseScopeKey(context, kind)]: projectId ?? null } })
  return key
}
export function changeContext(context: ConversationContext): void { useConversations.setState({ context }) }
export function selectProjectScope(context: ConversationContext, kind: ConversationKind, projectId?: string): void {
  useConversations.setState((state) => ({ projectScopes: { ...state.projectScopes, [baseScopeKey(context, kind)]: projectId ?? null } }))
  ensureScope(context, kind, projectId)
}
export function selectConversation(conversation: Conversation): string {
  const state = useConversations.getState(), existing = Object.values(state.entries).find((item) => !item.locked && item.conversation?.id === conversation.id)
  const key = existing?.key ?? conversation.id
  if (!existing) useConversations.setState({ entries: { ...state.entries, [key]: {
    key, owner: storageOwner(conversation.context), conversation, context: conversation.context, projectId: conversation.projectId, kind: conversation.kind,
    text: '', version: 0, savedVersion: 0, events: [], files: [], loaded: false, permissionPending: {}, permissionErrors: {}
  } } })
  useConversations.setState((current) => ({ context: conversation.context, selected: { ...current.selected, [scopeKey(conversation.context, conversation.kind, conversation.projectId)]: key }, projectScopes: { ...current.projectScopes, [baseScopeKey(conversation.context, conversation.kind)]: conversation.projectId ?? null } }))
  void readConversation(key)
  return key
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const creating = new Map<string, Promise<Conversation>>()
const saving = new Map<string, Promise<void>>()
const reading = new Map<string, number>()
const fileReads = new Map<string, number>()
function stopSaveTimer(key: string): void { clearTimeout(saveTimers.get(key)); saveTimers.delete(key) }
function queueSave(key: string): void {
  stopSaveTimer(key)
  saveTimers.set(key, setTimeout(() => { saveTimers.delete(key); void saveDraft(key).catch(() => undefined) }, 550))
}
export function editDraft(key: string, text: string): void {
  patchEntry(key, (current) => ({ text, version: current.version + 1, localUpdatedAt: Date.now(), saveError: undefined }))
  if (text || entry(key)?.conversation) queueSave(key)
}
export function setDraftImages(key: string, images: AcpImageAttachment[], expectedOwner?: string): void {
  const current = entry(key)
  if (!current || current.owner !== expectedOwner) return
  patchEntry(key, { images, imageVersion: (current.imageVersion ?? 0) + 1 })
}
export function requestComposerFocus(key: string): void { if (entry(key)) patchEntry(key, { composerFocus: crypto.randomUUID() }) }

export interface ConversationNativeOwner { conversationId: string; sessionId: string; root: string; generation: string }
export function conversationNativeOwner(key: string): ConversationNativeOwner | null {
  const current = entry(key), conversation = current?.conversation, session = current?.session
  if (!conversation || !session?.connectionGeneration || !ownsSession(session, conversation)) return null
  return { conversationId: conversation.id, sessionId: session.sessionId, root: conversation.workspace.root, generation: session.connectionGeneration }
}
export function ownsConversationNative(key: string, expected: ConversationNativeOwner): boolean {
  const actual = conversationNativeOwner(key)
  return Boolean(actual && actual.conversationId === expected.conversationId && actual.sessionId === expected.sessionId && actual.generation === expected.generation && projectRootKey(actual.root) === projectRootKey(expected.root))
}
const configurationLocks = new Map<string, symbol>()
type ConfigurationLease = (() => void) & { isCurrent(): boolean }
export function acquireConversationConfiguration(key: string, owner: ConversationNativeOwner, recovering = false): ConfigurationLease | undefined {
  const current = entry(key)
  if (!current || current.action || configurationLocks.has(key) || !ownsConversationNative(key, owner) || (!recovering && current.session?.status !== 'ready') || current.session?.cleanupRequired) return
  const token = Symbol(key)
  configurationLocks.set(key, token); patchEntry(key, { action: recovering ? 'recover-model' : 'configure' })
  const release = (): void => {
    if (configurationLocks.get(key) !== token) return
    configurationLocks.delete(key)
    if (['configure', 'recover-model'].includes(entry(key)?.action ?? '')) patchEntry(key, { action: undefined })
  }
  return Object.assign(release, { isCurrent: () => configurationLocks.get(key) === token && ownsConversationNative(key, owner) && entry(key)?.action === (recovering ? 'recover-model' : 'configure') })
}
export function acceptConversationSession(key: string, session: AcpSessionRecord, owner: ConversationNativeOwner, generationMayChange = false, isRecoveryCurrent?: () => boolean): boolean {
  const current = entry(key)
  if (!current?.conversation || !ownsConversationNative(key, owner) || !ownsSession(session, current.conversation) || !session.connectionGeneration || (!generationMayChange && session.connectionGeneration !== owner.generation) || (generationMayChange && (!isRecoveryCurrent?.() || !configurationLocks.has(key) || current.action !== 'recover-model'))) return false
  patchEntry(key, { session: generationMayChange ? session : newerSession(current.session, session), ...(generationMayChange ? { request: undefined } : {}) })
  return true
}
export function setDraftRuntime(key: string, runtimeId: string): void {
  const current = entry(key)
  if (!current || current.conversation?.nativeRef || current.action) return
  patchEntry(key, { runtimeId, version: current.version + 1 })
  if (current.conversation || current.text) queueSave(key)
}
async function persistIdentity(key: string): Promise<Conversation> {
  const current = entry(key), client = conversationClient()
  if (!current || !client) throw new Error('请在桌面应用中使用本机会话。')
  if (current.conversation) return current.conversation
  const pending = creating.get(key)
  if (pending) return pending
  if (current.kind === 'code' && !current.directory) throw new Error('请选择此 Code 会话可以访问的本机目录。')
  const operation = (async (): Promise<Conversation> => {
    const result = conversationValue(await client.createDraft({ kind: current.kind, context: current.context, projectId: current.projectId, directoryGrantId: current.directory?.grantId, runtimeId: current.runtimeId, text: current.text }))
    acceptRead(key, result); patchEntry(key, { savedVersion: current.version })
    return result.conversation
  })()
  creating.set(key, operation)
  try { return await operation } finally { creating.delete(key) }
}
export async function saveDraft(key: string, duringSend = false): Promise<void> {
  const previous = saving.get(key)
  if (previous) { await previous; return saveDraft(key, duringSend) }
  const current = entry(key), client = conversationClient()
  if (!current || !client || (current.action === 'sending' && !duringSend) || (current.kind === 'code' && !current.directory && !current.conversation) || (!current.conversation && !current.text)) return
  const operation = (async (): Promise<void> => {
    try {
      const conversation = await persistIdentity(key), latest = entry(key)
      if (!latest || latest.version === latest.savedVersion) return
      const read = conversationValue(await client.updateDraft(conversation.id, { text: latest.text, ...(latest.conversation?.nativeRef ? {} : { runtimeId: latest.runtimeId }) }))
      acceptRead(key, read); patchEntry(key, { savedVersion: latest.version, saveError: undefined })
    } catch (cause) { patchEntry(key, { saveError: conversationError(cause) }); throw cause }
  })()
  saving.set(key, operation)
  try { await operation } finally { if (saving.get(key) === operation) saving.delete(key) }
}

function validatePage(page: AcpHistoryEventPage, conversation: Conversation): void {
  if (!ownsSession(page.session, conversation) || page.events.some((event) => !ownsSession(event, conversation))) throw new Error('会话历史来源不匹配，未应用返回内容。')
}
export async function readConversation(key: string): Promise<void> {
  const current = entry(key), client = conversationClient()
  if (!current?.conversation || !client || current.loading) return
  const id = current.conversation.id, ticket = (reading.get(key) ?? 0) + 1
  reading.set(key, ticket); patchEntry(key, { loading: true })
  const valid = (): boolean => reading.get(key) === ticket && entry(key)?.conversation?.id === id
  try {
    const read = conversationValue(await client.read(id))
    if (!valid()) return
    acceptRead(key, read, !current.loaded)
    const page = conversationValue(await client.events(id, { limit: 120 }))
    if (!valid()) return
    if (page) {
      validatePage(page, read.conversation)
      patchEntry(key, (latest) => ({ events: mergeEvents(page.events, latest.events), page: latest.page?.beforeCursor ? { ...page, beforeCursor: latest.page.beforeCursor, hasEarlier: latest.page.hasEarlier } : page, session: newerSession(latest.session, { ...page.session, events: [] }) }))
    }
    patchEntry(key, { loaded: true, loadError: undefined })
  } catch (cause) { if (valid()) patchEntry(key, { loadError: conversationError(cause) }) }
  finally { if (valid()) patchEntry(key, { loading: false }) }
}
export async function earlierMessages(key: string): Promise<void> {
  const current = entry(key), client = conversationClient()
  if (!current?.conversation || !current.page?.beforeCursor || current.earlierLoading || !client) return
  const conversation = current.conversation, before = current.page.beforeCursor
  patchEntry(key, { earlierLoading: true })
  try {
    const page = conversationValue(await client.events(conversation.id, { before, limit: 120 }))
    if (entry(key)?.conversation?.id !== conversation.id || !page) return
    validatePage(page, conversation)
    patchEntry(key, (latest) => ({ events: mergeEvents(page.events, latest.events), page: { ...page, afterCursor: latest.page?.afterCursor ?? page.afterCursor }, loadError: undefined }))
  } catch (cause) { patchEntry(key, { loadError: conversationError(cause) }) }
  finally { patchEntry(key, { earlierLoading: false }) }
}

export function sessionRunning(current: WorkspaceEntry): boolean {
  const session = current.session
  if (!session || session.connectionOwned !== true || !session.connectionGeneration || !['starting', 'busy', 'awaiting_permission', 'cancelling'].includes(session.status)) return false
  return !current.events.some((event) => event.kind === 'turn-done' && event.sessionId === session.sessionId && projectRootKey(event.projectRoot) === projectRootKey(session.projectRoot) && event.connectionGeneration === session.connectionGeneration && event.turnId === session.turnId)
}
export function actionablePermissions(current: WorkspaceEntry, now: number): Record<string, AcpPermissionPayload> {
  const session = current.session, conversation = current.conversation
  if (!conversation || !session?.connectionOwned || !session.connectionGeneration) return {}
  return Object.fromEntries((session.pendingPermissions ?? []).filter((permission) => ownsSession(permission, conversation) && permission.connectionGeneration === session.connectionGeneration && (!permission.turnId || permission.turnId === session.turnId) && (permission.expiresAt === undefined || permission.expiresAt > now)).map((permission) => [permission.requestId, permission]))
}
export async function sendMessage(key: string): Promise<void> {
  const current = entry(key), client = conversationClient(), state = useConversations.getState()
  if (!current || !client || current.action || !current.loaded || (!current.text.trim() && !current.images?.length) || sessionRunning(current)) return
  if (current.images?.length && current.session && current.session.capabilities?.promptCapabilities?.image !== true) { patchEntry(key, { error: '当前执行引擎未声明支持图片输入，图片草稿已保留。' }); return }
  const runtimeId = current.session?.agentId ?? current.runtimeId ?? state.defaultRuntimeId
  if (!current.conversation?.nativeRef && (!runtimeId || !state.runtimes.some((runtime) => runtime.id === runtimeId && runtime.enabled && runtime.available) || (runtimeId === 'pi' && !state.configuredPi))) {
    patchEntry(key, { error: runtimeId === 'pi' ? '请先在设置中配置可用模型，草稿已保留。' : '请选择可用的执行引擎，草稿已保留。' }); return
  }
  const requestId = crypto.randomUUID(), version = current.version
  const images = current.images?.length ? current.images.slice() : undefined, imageVersion = current.imageVersion ?? 0
  const inputFiles = current.files.filter((file) => file.kind === 'input')
  const text = inputFiles.length ? `${current.text.trim()}\n\n会话输入文件（工作目录内的相对路径）：\n${inputFiles.map((file) => JSON.stringify(file.relativePath)).join('\n')}` : current.text.trim()
  if (text.length > 200_000) { patchEntry(key, { error: '消息与文件路径超过长度上限，请缩短消息后再发送。' }); return }
  stopSaveTimer(key); patchEntry(key, { action: 'sending', submission: { id: requestId, text, version }, error: undefined, following: true })
  try {
    await saving.get(key)
    const conversation = await persistIdentity(key), latest = entry(key)
    if (!latest || latest.submission?.id !== requestId) return
    const session = latest.session
    if (session && !ownsSession(session, conversation)) throw new Error('会话来源已改变，草稿已保留。')
    const generation = session?.connectionGeneration
    patchEntry(key, { request: session ? { requestId, projectRoot: conversation.workspace.root, sessionId: session.sessionId, connectionGeneration: generation, previousTurnId: session.turnId, phase: 'submitting' } : undefined })
    const response = conversationValue(await client.send(conversation.id, { requestId, text, images, expectedConnectionGeneration: generation }))
    if (entry(key)?.submission?.id !== requestId) return
    if (response.conversation.id !== conversation.id || !ownsSession(response.session, response.conversation)) throw new Error('发送结果的会话来源不匹配，请核对历史后重试。')
    keepConversation(response.conversation)
    patchEntry(key, (value) => ({
      conversation: response.conversation, session: newerSession(value.session, response.session), events: mergeEvents(response.session.events ?? [], mergeEvents(value.events, buffered(response.session))),
      request: { requestId, projectRoot: response.conversation.workspace.root, sessionId: response.session.sessionId, connectionGeneration: response.session.connectionGeneration, previousTurnId: session?.turnId, turnId: response.turnId, phase: 'accepted' },
      ...(value.version === version ? { text: '', version: version + 1, savedVersion: version + 1 } : { savedVersion: -1 }), saveError: undefined,
      ...(images ? { images: (value.imageVersion ?? 0) === imageVersion ? [] : (value.images ?? []).filter((image) => !images.some((sent) => sent.id === image.id && sent.data === image.data)), imageVersion: (value.imageVersion ?? 0) + 1 } : {})
    }))
    void readConversation(key); void refreshFiles(key)
  } catch (cause) {
    patchEntry(key, { error: `${conversationError(cause)} 未自动重发，请核对记录后再发送。`, request: undefined, savedVersion: -1 })
    if (entry(key)?.conversation) void readConversation(key)
  } finally {
    if (entry(key)?.submission?.id === requestId) { patchEntry(key, { action: undefined, submission: undefined }); const latest = entry(key); if (latest && latest.version !== latest.savedVersion) queueSave(key) }
  }
}
export async function controlConversation(key: string, action: 'cancel' | 'end'): Promise<void> {
  const current = entry(key), client = conversationClient(), generation = current?.session?.connectionGeneration
  if (!current?.conversation || !client || current.action || !generation || !current.session?.connectionOwned) return
  const id = current.conversation.id
  patchEntry(key, { action, error: undefined })
  try {
    conversationValue(await client[action](id, { expectedConnectionGeneration: generation }))
    if (entry(key)?.conversation?.id === id && entry(key)?.session?.connectionGeneration === generation) { patchEntry(key, { request: undefined }); await readConversation(key) }
  } catch (cause) { if (entry(key)?.session?.connectionGeneration === generation) patchEntry(key, { error: conversationError(cause) }) }
  finally { patchEntry(key, { action: undefined }) }
}
export async function respondPermission(key: string, requestId: string, optionId: string): Promise<void> {
  const current = entry(key), client = conversationClient()
  if (!current?.conversation || !client || current.permissionPending[requestId]) return
  const permission = actionablePermissions(current, Date.now())[requestId], generation = current.session?.connectionGeneration
  if (!permission || !generation || !permission.options.some((option) => option.optionId === optionId)) return
  patchEntry(key, { permissionPending: { ...current.permissionPending, [requestId]: true }, permissionErrors: { ...current.permissionErrors, [requestId]: '' } })
  try {
    conversationValue(await client.respond(current.conversation.id, { requestId, optionId, expectedConnectionGeneration: generation }))
    if (entry(key)?.session?.connectionGeneration !== generation) return
    patchEntry(key, (latest) => ({ session: latest.session ? { ...latest.session, pendingPermissions: latest.session.pendingPermissions?.filter((item) => item.requestId !== requestId) } : undefined }))
  } catch (cause) { if (entry(key)?.session?.connectionGeneration === generation) patchEntry(key, (latest) => ({ permissionErrors: { ...latest.permissionErrors, [requestId]: conversationError(cause) } })) }
  finally { patchEntry(key, (latest) => ({ permissionPending: { ...latest.permissionPending, [requestId]: false } })) }
}
export async function chooseDirectory(key: string): Promise<boolean> {
  const current = entry(key), client = conversationClient()
  if (!current || current.kind !== 'code' || !client || current.action || current.conversation?.nativeRef) return false
  patchEntry(key, { action: 'directory', error: undefined })
  try {
    const directory = conversationValue(await client.pickDirectory())
    if (!directory) return false
    if (current.conversation) {
      const read = conversationValue(await client.updateDraft(current.conversation.id, { directoryGrantId: directory.grantId }))
      reading.set(key, (reading.get(key) ?? 0) + 1); patchEntry(key, { directory, loading: false }); acceptRead(key, read)
    } else patchEntry(key, { directory })
    if (entry(key)?.text) queueSave(key)
    return Boolean(entry(key))
  } catch (cause) { patchEntry(key, { error: conversationError(cause) }); return false }
  finally { patchEntry(key, { action: undefined }) }
}
export async function addFiles(key: string): Promise<void> {
  const current = entry(key), client = conversationClient()
  if (!current || !client || current.action) return
  patchEntry(key, { action: 'files', fileError: undefined })
  try { const conversation = await persistIdentity(key); conversationValue(await client.pickFiles(conversation.id)); await refreshFiles(key) }
  catch (cause) { patchEntry(key, { fileError: conversationError(cause) }) }
  finally { patchEntry(key, { action: undefined }) }
}
export async function refreshFiles(key: string): Promise<void> {
  const current = entry(key), client = conversationClient()
  if (!current?.conversation || !client) return
  const id = current.conversation.id, ticket = (fileReads.get(key) ?? 0) + 1
  fileReads.set(key, ticket); patchEntry(key, { filesLoading: true })
  try {
    const files = conversationValue(await client.files(id))
    if (fileReads.get(key) === ticket && entry(key)?.conversation?.id === id) patchEntry(key, { files, filesLoaded: true, fileError: undefined })
  } catch (cause) { if (fileReads.get(key) === ticket) patchEntry(key, { fileError: conversationError(cause) }) }
  finally { if (fileReads.get(key) === ticket) patchEntry(key, { filesLoading: false }) }
}
export async function reclassifyConversation(key: string, projectId: string | null): Promise<void> {
  const current = entry(key), client = conversationClient()
  if (!current || !client || current.action) return
  const selectDestination = (): void => {
    const previousScope = scopeKey(current.context, current.kind, current.projectId), nextScope = scopeKey(current.context, current.kind, projectId ?? undefined)
    useConversations.setState((state) => {
      const selected = { ...state.selected }
      if (previousScope !== nextScope && selected[previousScope] === key) delete selected[previousScope]
      selected[nextScope] = key
      return { selected, projectScopes: { ...state.projectScopes, [baseScopeKey(current.context, current.kind)]: projectId } }
    })
  }
  if (!current.conversation) { patchEntry(key, { projectId: projectId ?? undefined }); selectDestination(); return }
  patchEntry(key, { action: 'classify' })
  try { acceptRead(key, conversationValue(await client.reclassify(current.conversation.id, { context: current.context, projectId }))); if (entry(key)) selectDestination() }
  catch (cause) { patchEntry(key, { error: conversationError(cause) }) }
  finally { patchEntry(key, { action: undefined }) }
}
export async function createProject(name: string, context: ConversationContext): Promise<ConversationProject> {
  const client = conversationClient()
  if (!client) throw new Error('请在桌面应用中创建专项。')
  const authority = authorityRevision
  const project = conversationValue(await client.createProject({ name, context }))
  if (context.kind === 'team' && authority !== authorityRevision) throw new Error('团队来源已改变，请在原账户中核对新建专项。')
  useConversations.setState((state) => ({ projects: [...state.projects.filter((item) => item.id !== project.id || contextKey(item.context) !== contextKey(project.context)), project] }))
  return project
}
export function selectArchive(id: string, context: ConversationContext, kind: ConversationKind, projectId?: string): void {
  useConversations.setState((state) => ({ selected: { ...state.selected, [scopeKey(context, kind, projectId)]: `archive:${id}` } }))
  if (!useConversations.getState().archiveReads[id]?.value) void readArchive(id)
}
const archiveReadTickets = new Map<string, number>()
export async function readArchive(id: string, branchId?: string): Promise<void> {
  if (!hasIpc) return
  const ticket = (archiveReadTickets.get(id) ?? 0) + 1
  archiveReadTickets.set(id, ticket)
  useConversations.setState((state) => ({ archiveReads: { ...state.archiveReads, [id]: { ...state.archiveReads[id], loading: true, error: undefined, branchId } } }))
  try {
    const result = await api.chatOpen(id, branchId)
    if (archiveReadTickets.get(id) !== ticket) return
    if (!result.ok || !result.session || result.session.id !== id) throw new Error(result.error ?? '历史记录无法读取。')
    useConversations.setState((state) => ({ archiveReads: { ...state.archiveReads, [id]: { value: result.session, branchId } } }))
  } catch (cause) { if (archiveReadTickets.get(id) === ticket) useConversations.setState((state) => ({ archiveReads: { ...state.archiveReads, [id]: { ...state.archiveReads[id], loading: false, error: conversationError(cause) } } })) }
}

// First-send events can precede the native identity acknowledgement. Only roots
// with a real pending send enter this bounded, exact-generation buffer.
const earlyEvents = new Map<string, TimelineEvent[]>()
const eventOwner = (value: { projectRoot?: string; sessionId?: string; connectionGeneration?: string }): string => JSON.stringify([projectRootKey(value.projectRoot), value.sessionId, value.connectionGeneration])
function buffered(session: AcpSessionRecord): TimelineEvent[] { return earlyEvents.get(eventOwner(session)) ?? [] }
let listening = false
function listen(): void {
  if (listening || !hasIpc) return
  listening = true
  api.onAcpOutput((event) => {
    const entries = Object.values(useConversations.getState().entries)
    if (entries.some((item) => item.action === 'sending' && item.conversation && projectRootKey(item.conversation.workspace.root) === projectRootKey(event.projectRoot))) {
      const owner = eventOwner(event); earlyEvents.set(owner, mergeEvents(earlyEvents.get(owner) ?? [], [event]).slice(-1200))
      if (earlyEvents.size > 20) earlyEvents.delete(earlyEvents.keys().next().value ?? '')
    }
    for (const item of entries) {
      if (!item.conversation || !ownsSession(event, item.conversation) || !item.session?.connectionGeneration || event.connectionGeneration !== item.session.connectionGeneration) continue
      patchEntry(item.key, (latest) => ({ events: mergeEvents(latest.events, [event]), ...(event.kind === 'turn-done' && event.turnId === latest.request?.turnId ? { request: undefined } : {}) }))
    }
  })
  api.onAcpState((state) => {
    for (const item of Object.values(useConversations.getState().entries)) {
      if (!item.conversation || !ownsSession(state, item.conversation)) continue
      if ((state.stateRevision ?? state.session?.stateRevision ?? 0) < (item.session?.stateRevision ?? 0)) continue
      if (item.action === 'recover-model' && (state.session?.connectionGeneration ?? state.connectionGeneration) !== item.session?.connectionGeneration) continue
      if (item.session?.connectionGeneration && state.connectionGeneration !== item.session.connectionGeneration && !state.session) continue
      const session = state.session ?? (item.session ? { ...item.session, status: state.status, stateRevision: state.stateRevision, pendingPermissions: state.pendingPermissions ?? [], error: state.error, turnId: state.turnId ?? item.session.turnId } : undefined)
      if (!session || !ownsSession(session, item.conversation)) continue
      patchEntry(item.key, (latest) => ({ session: newerSession(latest.session, session), events: mergeEvents(latest.events, buffered(session)), ...(latest.request && latest.request.connectionGeneration !== session.connectionGeneration && latest.action !== 'sending' ? { request: undefined } : {}) }))
    }
  })
  api.onAcpDone((done) => {
    for (const item of Object.values(useConversations.getState().entries)) {
      if (!item.conversation || !ownsSession(done, item.conversation) || !done.connectionGeneration || done.connectionGeneration !== item.session?.connectionGeneration) continue
      if (done.session && ownsSession(done.session, item.conversation)) patchEntry(item.key, { session: newerSession(item.session, done.session) })
      else if (item.session && done.turnId === item.session.turnId) patchEntry(item.key, { session: { ...item.session, status: done.status, pendingPermissions: [], error: done.error } })
      if (item.request?.turnId === done.turnId) patchEntry(item.key, { request: undefined })
      void readConversation(item.key); void refreshFiles(item.key)
    }
  })
}
let refreshing: Promise<void> | undefined
export async function refreshWorkspace(): Promise<void> {
  if (refreshing) return refreshing
  listen()
  const client = conversationClient()
  if (!client) { useConversations.setState({ initialized: true, loading: false }); return }
  useConversations.setState({ loading: true })
  refreshing = (async (): Promise<void> => {
    if (!useHifox.getState().workspaceContext.actorId) await useHifox.getState().bootstrap()
    const authority = authorityRevision, started = Date.now()
    const [list, projects, contexts, runtimes, settings, archives] = await Promise.allSettled([client.list(), client.projects(), client.contexts(), api.acpAgents(), api.getSettings(), api.chatList()])
    if (authority !== authorityRevision) return
    if (list.status === 'fulfilled' && list.value.ok) {
      useConversations.setState({ conversations: list.value.value, error: undefined })
    } else if (list.status === 'rejected') useConversations.setState({ error: conversationError(list.reason) })
    else if (!list.value.ok) useConversations.setState({ error: list.value.error })
    if (projects.status === 'fulfilled' && projects.value.ok) useConversations.setState({ projects: projects.value.value })
    else if (projects.status === 'rejected') useConversations.setState({ error: conversationError(projects.reason) })
    else if (!projects.value.ok) useConversations.setState({ error: projects.value.error })
    if (contexts.status === 'fulfilled' && contexts.value.ok) {
      const choices = [{ context: PERSONAL, name: '个人' }, ...contexts.value.value.filter((item) => item.context.kind === 'team')]
      useConversations.setState((state) => ({ contexts: choices, ...(state.context.kind === 'team' && !choices.some((choice) => contextKey(choice.context) === contextKey(state.context)) ? { context: PERSONAL } : {}) }))
    }
    else if (contexts.status === 'rejected') useConversations.setState({ error: conversationError(contexts.reason) })
    else if (!contexts.value.ok) useConversations.setState({ error: contexts.value.error })
    if (runtimes.status === 'fulfilled' && runtimes.value.ok) {
      const values = runtimes.value.agents ?? [], preferred = values.find((runtime) => runtime.id === 'pi' && runtime.enabled && runtime.available) ?? values.find((runtime) => runtime.enabled && runtime.available)
      useConversations.setState({ runtimes: values, defaultRuntimeId: preferred?.id, runtimeError: undefined })
      for (const item of Object.values(useConversations.getState().entries)) if (!item.runtimeId && !item.conversation?.nativeRef) patchEntry(item.key, { runtimeId: preferred?.id })
    } else useConversations.setState({ runtimeError: runtimes.status === 'rejected' ? conversationError(runtimes.reason) : runtimes.value.error ?? '执行引擎配置无法读取。' })
    if (settings.status === 'fulfilled') {
      const ai = settings.value.ai, candidates = ai.providers?.length ? ai.providers.filter((provider) => provider.enabled).flatMap((provider) => provider.models.filter((model) => model.enabled).map((model) => ({ provider, model }))) : []
      const selected = candidates.find(({ provider, model }) => provider.id === ai.activeProviderId && model.id === ai.model) ?? candidates.find(({ provider }) => provider.id === ai.activeProviderId) ?? candidates[0]
      useConversations.setState({ configuredPi: Boolean(selected || (ai.enabled && ai.model && ai.baseUrl)), modelLabel: selected ? `${selected.provider.name} · ${selected.model.name || selected.model.id}` : ai.enabled && ai.model ? ai.model : undefined })
      try {
        restoringStorage = true
        nativeNamespace = await installationNamespace(settings.value.bridgeToken)
        if (authority !== authorityRevision) return
        useConversations.setState((state) => ({ entries: Object.fromEntries(Object.entries(state.entries).map(([key, value]) => [key, !value.owner && !value.locked ? { ...value, owner: storageOwner(value.context) } : value])) }))
        if (list.status === 'fulfilled' && list.value.ok && contexts.status === 'fulfilled' && contexts.value.ok) {
          const allowed = new Set(list.value.value.map((item) => item.id)), current = useConversations.getState()
          useConversations.setState({ entries: Object.fromEntries(Object.entries(current.entries).map(([key, value]) => {
            if (value.context.kind !== 'team') return [key, value]
            const sameOwner = value.owner === storageOwner(value.context), knownContext = current.contexts.some((choice) => contextKey(choice.context) === contextKey(value.context))
            const allowedEntry = sameOwner && knownContext && (!value.conversation || allowed.has(value.conversation.id) || value.conversation.createdAt > started)
            return [key, allowedEntry ? { ...value, locked: false } : { ...value, locked: true, session: undefined, events: [], request: undefined, loaded: false }]
          })) })
          restoreLocalDrafts()
        }
      } catch (cause) { useConversations.setState({ storageError: conversationError(cause) }) }
      finally { restoringStorage = false; persistLocalDrafts() }
    } else useConversations.setState({ runtimeError: conversationError(settings.reason), configuredPi: false })
    if (archives.status === 'fulfilled' && archives.value.ok) useConversations.setState({ archives: archives.value.sessions ?? [], archiveError: undefined })
    else useConversations.setState({ archiveError: archives.status === 'rejected' ? conversationError(archives.reason) : archives.value.error ?? '旧问答记录无法读取。' })
    useConversations.setState({ loading: false, initialized: true })
  })()
  try { await refreshing }
  catch (cause) { useConversations.setState({ loading: false, initialized: true, error: conversationError(cause) }) }
  finally { refreshing = undefined }
}

if (typeof window !== 'undefined') {
  const flush = (): void => {
    persistLocalDrafts()
    for (const key of saveTimers.keys()) { stopSaveTimer(key); void saveDraft(key).catch(() => undefined) }
  }
  window.addEventListener('pagehide', flush)
  window.addEventListener('blur', flush)
}
