import { create } from 'zustand'
import type { AcpHistoryEventPage } from '@shared/acp-history'
import type { Conversation, ConversationDirectoryGrant, ConversationFile, ConversationProject, ConversationRead } from '@shared/private-conversations'
import type { AcpAgentStatus, AcpSessionRecord, ChatSessionMeta, ChatSessionView, TimelineEvent } from '@shared/types'
import type { AcpImageAttachment } from '@shared/acp-images'
import type { CurrentTurnRequest } from '../acp/current-turn-activity'
import { mergeEvents } from '../acp/timeline'
import { api, hasIpc } from '../api'
import { projectRootKey } from '../my/navigation'
import { conversationClient, conversationError, conversationValue } from './client'
import { installationNamespace, readStoredWorkspace, writeStoredWorkspace, type StoredWorkspace } from './draft-storage'
import { piModelChoices } from './pi-models'
import { useApp } from '../store'
import { modelIdWithinLimit } from '@shared/model-selection'

export type ConversationKind = Conversation['kind']
export const baseScopeKey = (kind: ConversationKind): string => kind
export const scopeKey = (kind: ConversationKind, projectId?: string): string => `${kind}:${projectId ?? ''}`

type StoredSubmission = NonNullable<StoredWorkspace['entries'][number]['submission']>

export interface WorkspaceEntry {
  key: string
  owner?: string
  locked?: boolean
  localUpdatedAt?: number
  kind: ConversationKind
  projectId?: string
  conversation?: Conversation
  directory?: ConversationDirectoryGrant
  text: string
  images?: AcpImageAttachment[]
  runtimeId?: string
  modelId?: string
  modelTooLong?: boolean
  modelConfirmationRequired?: boolean
  version: number
  savedVersion: number
  session?: AcpSessionRecord
  events: TimelineEvent[]
  discussion?: AcpHistoryEventPage['discussion']
  page?: AcpHistoryEventPage | null
  fileReferenceVersion?: number
  inputReferenceVersions?: Record<string, number>
  selectedInputIds?: string[]
  excludedInputIds?: string[]
  files: ConversationFile[]
  filesLoaded?: boolean
  filesLoading?: boolean
  loaded: boolean
  loading?: boolean
  readTimings?: { metadataMs?: number; historyMs?: number; totalMs?: number }
  earlierLoading?: boolean
  error?: string
  loadError?: string
  saveError?: string
  fileError?: string
  nativeError?: string
  action?: 'sending' | 'cancel' | 'end' | 'files' | 'directory' | 'classify' | 'configure' | 'recover-model' | 'connect'
  submission?: StoredSubmission & { images?: AcpImageAttachment[] }
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
  conversations: Conversation[]
  projects: ConversationProject[]
  runtimes: AcpAgentStatus[]
  defaultRuntimeId?: string
  configuredPi: boolean
  modelLabel?: string
  piModels: Array<{ id: string; label: string; available: boolean }>
  defaultPiModelId?: string
  archives: ChatSessionMeta[]
  archiveReads: Record<string, { loading?: boolean; value?: ChatSessionView; error?: string; branchId?: string }>
  loading: boolean
  initialized: boolean
  error?: string
  runtimeError?: string
  archiveError?: string
  storageError?: string
  managementBusy: Record<string, boolean>
  managementErrors: Record<string, string>
}
export const useConversations = create<ConversationWorkspace>(() => ({
  entries: {}, selected: {}, projectScopes: {}, conversations: [], projects: [], runtimes: [], configuredPi: false, piModels: [],
  archives: [], archiveReads: {}, loading: false, initialized: false, managementBusy: {}, managementErrors: {}
}))
let nativeNamespace = '', restoringStorage = false, restoredStorageOwner = '', unreadableStorage = ''
let preservedSnapshot: StoredWorkspace | null = null, selectionRevision = 0, metadataRevision = 0
interface ManagementReceipt { title?: [number, string]; pinnedAt?: [number, number | undefined]; archivedAt?: [number, number | undefined] }
const managementReceipts = new Map<string, ManagementReceipt>()
const publications = new Map<string, { revision: number; conversation: Conversation }>()
const entry = (key: string): WorkspaceEntry | undefined => { const value = useConversations.getState().entries[key]; return value?.locked ? undefined : value }
export function patchEntry(key: string, update: Partial<WorkspaceEntry> | ((previous: WorkspaceEntry) => Partial<WorkspaceEntry>)): void {
  useConversations.setState((state) => {
    const previous = state.entries[key]
    return previous && !previous.locked ? { entries: { ...state.entries, [key]: { ...previous, ...(typeof update === 'function' ? update(previous) : update) } } } : state
  })
}
const compareConversations = (a: Conversation, b: Conversation): number => Number(b.pinnedAt !== undefined) - Number(a.pinnedAt !== undefined) || (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
function knownConversation(id: string): Conversation | undefined {
  const state = useConversations.getState()
  return state.conversations.find((item) => item.id === id) ?? Object.values(state.entries).find((item) => item.conversation?.id === id)?.conversation
}
function mergeConversation(incoming: Conversation, readRevision: number, index?: ReadonlyMap<string, Conversation>): Conversation {
  const known = index ? index.get(incoming.id) : knownConversation(incoming.id)
  let next = known && known.updatedAt > incoming.updatedAt ? { ...known } : { ...incoming }
  if (known?.nativeRef) next = { ...next, kind: known.kind, creatorId: known.creatorId, workspace: known.workspace, nativeRef: known.nativeRef }
  const publication = publications.get(incoming.id)
  if (known?.conversationPreview && publication && publication.revision > readRevision && known.updatedAt >= incoming.updatedAt) next.conversationPreview = known.conversationPreview
  const receipt = managementReceipts.get(incoming.id)
  if (receipt?.title && receipt.title[0] > readRevision) next.title = receipt.title[1]
  if (receipt?.pinnedAt && receipt.pinnedAt[0] > readRevision) next.pinnedAt = receipt.pinnedAt[1]
  if (receipt?.archivedAt && receipt.archivedAt[0] > readRevision) next.archivedAt = receipt.archivedAt[1]
  return next
}
function keepConversation(incoming: Conversation, readRevision = metadataRevision): Conversation {
  const conversation = mergeConversation(incoming, readRevision)
  publications.set(conversation.id, { revision: ++metadataRevision, conversation })
  useConversations.setState((state) => ({ conversations: [conversation, ...state.conversations.filter((item) => item.id !== conversation.id)].sort(compareConversations) }))
  return conversation
}
function acceptCatalog(values: Conversation[], readRevision: number): void {
  const state = useConversations.getState(), knownById = new Map(state.conversations.map((item) => [item.id, item]))
  for (const item of Object.values(state.entries)) if (item.conversation && !knownById.has(item.conversation.id)) knownById.set(item.conversation.id, item.conversation)
  const byId = new Map(values.map((value) => { const merged = mergeConversation(value, readRevision, knownById); return [merged.id, merged] }))
  for (const [id, publication] of publications) if (publication.revision > readRevision && !byId.has(id)) byId.set(id, publication.conversation)
  useConversations.setState((state) => ({
    conversations: [...byId.values()].sort(compareConversations),
    entries: Object.fromEntries(Object.entries(state.entries).map(([key, item]) => {
      const metadata = item.conversation ? byId.get(item.conversation.id) : undefined
      return [key, metadata && !item.locked ? { ...item, conversation: metadata, projectId: metadata.projectId } : item]
    }))
  }))
}
function ownsSession(record: { projectRoot?: string; sessionId?: string }, conversation: Conversation): boolean {
  return Boolean(conversation.nativeRef && record.sessionId === conversation.nativeRef.sessionId && projectRootKey(record.projectRoot) === projectRootKey(conversation.workspace.root))
}
function newerSession(previous: AcpSessionRecord | undefined, next: AcpSessionRecord): AcpSessionRecord {
  return previous && previous.connectionGeneration === next.connectionGeneration && (previous.stateRevision ?? 0) > (next.stateRevision ?? 0) ? previous : next
}
function acceptRead(key: string, read: ConversationRead, loadDraft = false, readRevision = metadataRevision): void {
  const previous = entry(key)
  if (!previous || previous.kind !== read.conversation.kind || previous.conversation && previous.conversation.id !== read.conversation.id) return
  if (previous.conversation && projectRootKey(previous.conversation.workspace.root) !== projectRootKey(read.conversation.workspace.root) && projectRootKey(previous.directory?.path) !== projectRootKey(read.conversation.workspace.root)) return
  if (previous.conversation?.nativeRef && (!read.conversation.nativeRef || previous.conversation.nativeRef.sessionId !== read.conversation.nativeRef.sessionId)) return
  if (read.session && !ownsSession(read.session, read.conversation)) throw new Error('会话来源不匹配，请重新打开。')
  const conversation = keepConversation(read.conversation, readRevision)
  patchEntry(key, (current) => ({ conversation, projectId: conversation.projectId,
    ...(loadDraft && current.version === 0 ? { text: read.draft.text, runtimeId: read.draft.runtimeId ?? current.runtimeId, modelId: read.draft.modelId && modelIdWithinLimit(read.draft.modelId) ? read.draft.modelId : undefined, modelTooLong: Boolean(read.draft.modelId && !modelIdWithinLimit(read.draft.modelId)), savedVersion: 0 } : {}),
    nativeError: read.runtimeError,
    modelConfirmationRequired: read.modelConfirmationRequired === true,
    ...(read.session && !(current.action === 'recover-model' && current.session?.connectionGeneration !== read.session.connectionGeneration) ? { session: newerSession(current.session, read.session) } : {})
  }))
}
function draftEntry(kind: ConversationKind, projectId?: string, directory?: ConversationDirectoryGrant): WorkspaceEntry {
  return { key: `draft:${crypto.randomUUID()}`, owner: nativeNamespace || undefined, localUpdatedAt: Date.now(), kind, projectId, directory,
    text: '', runtimeId: useConversations.getState().defaultRuntimeId, version: 0, savedVersion: -1,
    events: [], files: [], loaded: true, permissionPending: {}, permissionErrors: {}, composerFocus: crypto.randomUUID() }
}
function installDraft(kind: ConversationKind, projectId?: string, directory?: ConversationDirectoryGrant): string {
  const state = useConversations.getState(), scope = scopeKey(kind, projectId)
  const pristine = Object.values(state.entries).find((item) => !item.locked && !item.conversation && item.kind === kind && item.projectId === projectId && !item.text && !item.images?.length && !item.submission && !item.directory && !item.action)
  const value = pristine ? { ...pristine, directory, composerFocus: crypto.randomUUID() } : draftEntry(kind, projectId, directory)
  useConversations.setState({ entries: { ...state.entries, [value.key]: value }, selected: { ...state.selected, [scope]: value.key }, projectScopes: { ...state.projectScopes, [baseScopeKey(kind)]: projectId ?? null } })
  return value.key
}
export function ensureScope(kind: ConversationKind, projectId?: string): string {
  const selected = useConversations.getState().selected[scopeKey(kind, projectId)]
  return selected && (selected.startsWith('archive:') || entry(selected)) ? selected : installDraft(kind, projectId)
}
export function newDraft(kind: ConversationKind, projectId?: string, directory?: ConversationDirectoryGrant): string { selectionRevision++; return installDraft(kind, projectId, directory) }
export function selectProjectScope(kind: ConversationKind, projectId?: string): void {
  selectionRevision++; useConversations.setState((state) => ({ projectScopes: { ...state.projectScopes, [baseScopeKey(kind)]: projectId ?? null } })); ensureScope(kind, projectId)
}
function unloadedEntry(conversation: Conversation): WorkspaceEntry {
  return { key: conversation.id, owner: nativeNamespace || undefined, conversation, kind: conversation.kind, projectId: conversation.projectId,
    text: '', version: 0, savedVersion: 0, events: [], files: [], loaded: false, permissionPending: {}, permissionErrors: {} }
}
export function selectConversation(incoming: Conversation): string {
  selectionRevision++
  const conversation = mergeConversation(incoming, metadataRevision), state = useConversations.getState()
  const existing = Object.values(state.entries).find((item) => !item.locked && item.conversation?.id === conversation.id)
  const value = existing ?? unloadedEntry(conversation)
  useConversations.setState({ entries: { ...state.entries, [value.key]: { ...value, conversation, projectId: conversation.projectId } },
    selected: { ...state.selected, [scopeKey(conversation.kind, conversation.projectId)]: value.key },
    projectScopes: { ...state.projectScopes, [baseScopeKey(conversation.kind)]: conversation.projectId ?? null } })
  void readConversation(value.key)
  return value.key
}
export interface ConversationManagementUpdate { title?: string; pinned?: boolean; archived?: boolean }
export async function updateConversation(id: string, input: ConversationManagementUpdate): Promise<Conversation | null> {
  const client = conversationClient()
  if (!client || useConversations.getState().managementBusy[id]) return null
  useConversations.setState((state) => ({ managementBusy: { ...state.managementBusy, [id]: true }, managementErrors: { ...state.managementErrors, [id]: '' } }))
  try {
    const read = conversationValue(await client.updateDraft(id, input)), known = knownConversation(id) ?? read.conversation
    if (read.conversation.id !== id || read.conversation.kind !== known.kind || read.conversation.creatorId !== known.creatorId || known.nativeRef && read.conversation.nativeRef && (known.nativeRef.sessionId !== read.conversation.nativeRef.sessionId || projectRootKey(known.workspace.root) !== projectRootKey(read.conversation.workspace.root))) throw new Error('会话身份已改变，未应用管理回执。')
    const revision = ++metadataRevision, receipt: ManagementReceipt = { ...managementReceipts.get(id) }
    const next: Conversation = { ...known, updatedAt: Math.max(known.updatedAt, read.conversation.updatedAt) }
    if (input.title !== undefined) { next.title = read.conversation.title; receipt.title = [revision, next.title] }
    if (input.pinned !== undefined) { next.pinnedAt = read.conversation.pinnedAt; receipt.pinnedAt = [revision, next.pinnedAt] }
    if (input.archived !== undefined) { next.archivedAt = read.conversation.archivedAt; receipt.archivedAt = [revision, next.archivedAt] }
    managementReceipts.set(id, receipt)
    const metadata = keepConversation(next, revision)
    useConversations.setState((state) => ({ entries: Object.fromEntries(Object.entries(state.entries).map(([key, item]) => [key, item.conversation?.id === id ? { ...item, conversation: { ...item.conversation, title: metadata.title, pinnedAt: metadata.pinnedAt, archivedAt: metadata.archivedAt, updatedAt: metadata.updatedAt } } : item])) }))
    if (input.archived === true && metadata.archivedAt !== undefined) replaceArchivedSelections(id)
    return metadata
  } catch (cause) { useConversations.setState((state) => ({ managementErrors: { ...state.managementErrors, [id]: conversationError(cause) } })); return null }
  finally { useConversations.setState((state) => ({ managementBusy: { ...state.managementBusy, [id]: false } })) }
}
function replaceArchivedSelections(id: string): void {
  useConversations.setState((state) => {
    const entries = { ...state.entries }, selected = { ...state.selected }
    for (const [scope, key] of Object.entries(selected)) {
      const current = entries[key]
      if (current?.conversation?.id !== id) continue
      const candidate = state.conversations.find((item) => item.id !== id && item.archivedAt === undefined && item.kind === current.kind && item.projectId === current.projectId)
      const replacement = candidate ? Object.values(entries).find((item) => !item.locked && item.conversation?.id === candidate.id) ?? unloadedEntry(candidate) : draftEntry(current.kind, current.projectId)
      entries[replacement.key] = replacement; selected[scope] = replacement.key
    }
    return { entries, selected }
  })
}
function storedSubmission(submission: WorkspaceEntry['submission']): StoredSubmission | undefined {
  if (!submission) return
  const { images: _images, ...stored } = submission
  return stored
}
function persistLocalDrafts(): void {
  if (!nativeNamespace || restoringStorage || unreadableStorage) return
  const state = useConversations.getState()
  try {
    const selectedKeys = new Set(Object.values(state.selected)), byKey = new Map((preservedSnapshot?.entries ?? []).map((item) => [item.key, item]))
    for (const item of Object.values(state.entries)) {
      if (item.owner !== nativeNamespace || item.locked) continue
      byKey.set(item.key, { key: item.key, conversationId: item.conversation?.id, kind: item.kind, projectId: item.projectId,
        text: item.text, submission: storedSubmission(item.submission), excludedInputIds: item.excludedInputIds, selectedInputIds: item.selectedInputIds, fileReferenceVersion: item.fileReferenceVersion, inputReferenceVersions: item.inputReferenceVersions, runtimeId: item.runtimeId, modelId: item.modelId, modelTooLong: item.modelTooLong, dirty: item.version !== item.savedVersion || Boolean(item.submission), updatedAt: item.localUpdatedAt ?? item.conversation?.updatedAt ?? Date.now() })
    }
    const values = [...byKey.values()].filter((item) => item.conversationId ? item.dirty || selectedKeys.has(item.key) || Boolean(item.excludedInputIds?.length) || Boolean(item.selectedInputIds?.length) : Boolean(item.text || item.submission))
    if (values.length > 200) throw new Error('本机草稿缓存已达到 200 条上限，请先保存未选择目录的 Code 草稿。')
    const keys = new Set(values.map((item) => item.key))
    const snapshot: StoredWorkspace = { version: 2, entries: values,
      selected: Object.fromEntries(Object.entries(state.selected).filter(([, key]) => keys.has(key) || key.startsWith('archive:'))),
      projects: Object.fromEntries(Object.entries(state.projectScopes).filter(([key]) => key === 'work' || key === 'code')) }
    writeStoredWorkspace(nativeNamespace, snapshot); preservedSnapshot = snapshot
    if (state.storageError) useConversations.setState({ storageError: undefined })
  } catch (cause) { useConversations.setState({ storageError: conversationError(cause) }) }
}
function restoreLocalDrafts(admittedConversationIds: ReadonlySet<string>): void {
  const state = useConversations.getState(), first = restoredStorageOwner !== nativeNamespace
  try {
    if (first) { preservedSnapshot = readStoredWorkspace(nativeNamespace, admittedConversationIds); restoredStorageOwner = nativeNamespace }
    const saved = preservedSnapshot
    if (!saved) return
    const byId = new Map(state.conversations.map((item) => [item.id, item])), projects = new Set(state.projects.map((item) => item.id))
    const existingById = new Map(Object.values(state.entries).flatMap((item) => item.conversation ? [[item.conversation.id, item] as const] : []))
    const restored: Record<string, WorkspaceEntry> = {}, aliases = new Map<string, string>()
    for (const item of saved.entries) {
      const conversation = item.conversationId ? byId.get(item.conversationId) : undefined
      if (item.conversationId && !conversation) continue
      const existing = state.entries[item.key] ?? (item.conversationId ? existingById.get(item.conversationId) : undefined)
      if (existing) {
        aliases.set(item.key, existing.key)
        if (!existing.locked && (item.selectedInputIds && existing.selectedInputIds === undefined || item.excludedInputIds && existing.excludedInputIds === undefined || item.submission && !existing.submission)) restored[existing.key] = { ...existing,
          selectedInputIds: existing.selectedInputIds ?? item.selectedInputIds, excludedInputIds: existing.excludedInputIds ?? item.excludedInputIds,
          fileReferenceVersion: Math.max(existing.fileReferenceVersion ?? 0, item.fileReferenceVersion ?? 0), inputReferenceVersions: { ...item.inputReferenceVersions, ...existing.inputReferenceVersions },
          ...(item.submission && !existing.submission ? { submission: { ...item.submission, state: item.submission.state === 'failed' ? 'failed' as const : 'unknown' as const } } : {}) }
        if (item.dirty && existing.version === 0 && !existing.text && !existing.images?.length && !existing.locked) restored[existing.key] = { ...existing, selectedInputIds: existing.selectedInputIds ?? item.selectedInputIds, excludedInputIds: existing.excludedInputIds ?? item.excludedInputIds, fileReferenceVersion: Math.max(existing.fileReferenceVersion ?? 0, item.fileReferenceVersion ?? 0), inputReferenceVersions: { ...item.inputReferenceVersions, ...existing.inputReferenceVersions }, text: item.text, submission: item.submission ? { ...item.submission, state: item.submission.state === 'failed' ? 'failed' : 'unknown' } : undefined, runtimeId: item.runtimeId ?? existing.runtimeId, modelId: item.modelId, modelTooLong: item.modelTooLong, version: 1, savedVersion: -1 }
        continue
      }
      const projectId = conversation?.projectId ?? (item.projectId && projects.has(item.projectId) ? item.projectId : undefined)
      restored[item.key] = { key: item.key, owner: nativeNamespace, localUpdatedAt: item.updatedAt, conversation, kind: conversation?.kind ?? item.kind, projectId,
        selectedInputIds: item.selectedInputIds, excludedInputIds: item.excludedInputIds, fileReferenceVersion: item.fileReferenceVersion, inputReferenceVersions: item.inputReferenceVersions, text: item.dirty || !conversation ? item.text : '', submission: item.submission ? { ...item.submission, state: item.submission.state === 'failed' ? 'failed' : 'unknown' } : undefined, runtimeId: item.runtimeId ?? state.defaultRuntimeId, modelId: item.modelId, modelTooLong: item.modelTooLong,
        version: item.dirty ? 1 : 0, savedVersion: item.dirty ? -1 : 0, events: [], files: [], loaded: !conversation, permissionPending: {}, permissionErrors: {} }
      aliases.set(item.key, item.key)
    }
    useConversations.setState((latest) => {
      const entries = { ...latest.entries, ...restored }, selected = { ...latest.selected }, projectScopes = { ...latest.projectScopes }
      if (first && selectionRevision === 0) {
        for (const [storedScope, storedKey] of Object.entries(saved.selected)) {
          if (storedKey.startsWith('archive:') && /^(work|code):/.test(storedScope)) { selected[storedScope] = storedKey; continue }
          const value = entries[aliases.get(storedKey) ?? '']
          if (!value) continue
          const scope = scopeKey(value.kind, value.projectId), previous = entries[selected[scope] ?? '']
          if (!previous || !previous.conversation && !previous.text && !previous.images?.length && !previous.submission && !previous.action) selected[scope] = value.key
        }
        for (const kind of ['work', 'code'] as const) if (kind in saved.projects) projectScopes[kind] = saved.projects[kind] && projects.has(saved.projects[kind] ?? '') ? saved.projects[kind] : null
      }
      return { entries, selected, projectScopes }
    })
    for (const item of Object.values(restored)) if (item.version !== item.savedVersion) queueSave(item.key)
  } catch (cause) { unreadableStorage = conversationError(cause); useConversations.setState({ storageError: unreadableStorage }) }
}
let localFingerprint = ''
useConversations.subscribe((state) => {
  const fingerprint = JSON.stringify([state.selected, state.projectScopes, Object.values(state.entries).map((item) => [item.key, item.owner, item.version, item.savedVersion, item.projectId, item.conversation?.id, item.locked, item.excludedInputIds, item.selectedInputIds, item.fileReferenceVersion, item.inputReferenceVersions])])
  if (fingerprint === localFingerprint) return
  localFingerprint = fingerprint; persistLocalDrafts()
})

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const creating = new Map<string, Promise<Conversation>>()
const saving = new Map<string, Promise<void>>()
const reading = new Map<string, number>()
const conversationReads = new Map<string, { owner: string; promise: Promise<void> }>()
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
  patchEntry(key, { images })
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
  if (!current || current.action || configurationLocks.has(key) || !ownsConversationNative(key, owner) || (!recovering && current.session?.status !== 'ready') || current.session?.cleanupRequired || current.conversation?.archivedAt !== undefined) return
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
export function setDraftSelection(key: string, runtimeId: string, modelId?: string): boolean {
  const current = entry(key)
  if (!current || current.conversation?.nativeRef || current.action || current.conversation?.archivedAt !== undefined) return false
  const { runtimes, piModels } = useConversations.getState()
  if (!runtimes.some((runtime) => runtime.id === runtimeId && runtime.enabled && runtime.available)) return false
  if (modelId !== undefined && (runtimeId !== 'pi' || !piModels.some((model) => model.id === modelId && model.available) || !modelIdWithinLimit(modelId))) return false
  patchEntry(key, {
    runtimeId,
    ...(modelId !== undefined ? { modelId, modelTooLong: false } : {}),
    version: current.version + 1
  })
  if (current.conversation || current.text) queueSave(key)
  return true
}
async function persistIdentity(key: string): Promise<Conversation> {
  const current = entry(key), client = conversationClient()
  if (!current || !client) throw new Error('请在桌面应用中使用本机会话。')
  if (current.conversation) return current.conversation
  const pending = creating.get(key)
  if (pending) return pending
  if (current.kind === 'code' && !current.directory) throw new Error('请选择此 Code 会话可以访问的本机目录。')
  const readRevision = metadataRevision
  const operation = (async (): Promise<Conversation> => {
    const result = conversationValue(await client.createDraft({ kind: current.kind, projectId: current.projectId, directoryGrantId: current.directory?.grantId, runtimeId: current.runtimeId, modelId: current.modelId, text: current.text }))
    acceptRead(key, result, false, readRevision); patchEntry(key, { savedVersion: current.version })
    return result.conversation
  })()
  creating.set(key, operation)
  try { return await operation } finally { creating.delete(key) }
}
/** Explicit requirement/file interactions may create a durable draft without starting an assistant. */
export async function ensureConversation(key: string): Promise<Conversation> {
  const current = entry(key)
  if (!current || !current.loaded || current.action || current.conversation?.archivedAt !== undefined) throw new Error('当前会话暂不可创建需求，请返回会话后重试。')
  const owner = current.owner, conversation = await persistIdentity(key), latest = entry(key)
  if (!latest || latest.owner !== owner || latest.conversation?.id !== conversation.id || projectRootKey(latest.conversation.workspace.root) !== projectRootKey(conversation.workspace.root)) throw new Error('会话来源已改变，未继续创建需求。')
  return latest.conversation
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
      const readRevision = metadataRevision
      const read = conversationValue(await client.updateDraft(conversation.id, { text: latest.text, ...(latest.conversation?.nativeRef ? {} : { runtimeId: latest.runtimeId, ...(latest.modelTooLong ? {} : { modelId: latest.modelId ?? null }) }) }))
      acceptRead(key, read, false, readRevision); patchEntry(key, { savedVersion: latest.version, saveError: undefined })
    } catch (cause) { patchEntry(key, { saveError: conversationError(cause) }); throw cause }
  })()
  saving.set(key, operation)
  try { await operation } finally { if (saving.get(key) === operation) saving.delete(key) }
}

function validatePage(page: AcpHistoryEventPage, conversation: Conversation): void {
  if (!ownsSession(page.session, conversation) || [...page.events, ...(page.discussion?.events ?? [])].some((event) => !ownsSession(event, conversation))) throw new Error('会话历史来源不匹配，未应用返回内容。')
}
export function readConversation(key: string): Promise<void> {
  const current = entry(key)
  if (!current?.conversation) return Promise.resolve()
  const owner = JSON.stringify([current.owner, current.conversation.id, projectRootKey(current.conversation.workspace.root)])
  const existing = conversationReads.get(key)
  if (existing?.owner === owner) return existing.promise
  const promise = readConversationOwned(key).finally(() => { if (conversationReads.get(key)?.promise === promise) conversationReads.delete(key) })
  conversationReads.set(key, { owner, promise })
  return promise
}
async function readConversationOwned(key: string): Promise<void> {
  const current = entry(key), client = conversationClient()
  if (!current?.conversation || !client) return
  const readRevision = metadataRevision
  const originalGeneration = current.session?.connectionGeneration
  const id = current.conversation.id, ticket = (reading.get(key) ?? 0) + 1
  reading.set(key, ticket); patchEntry(key, { loading: true, readTimings: {} })
  const valid = (): boolean => reading.get(key) === ticket && entry(key)?.conversation?.id === id
  const started = performance.now()
  let metadataError: string | undefined, historyError: string | undefined
  try {
    const metadata = Promise.resolve().then(() => client.read(id)).then(conversationValue).then(read => {
      if (!valid()) return
      const acknowledgedGeneration = entry(key)?.session?.connectionGeneration
      if (acknowledgedGeneration !== originalGeneration && read.session?.connectionGeneration !== acknowledgedGeneration && !(originalGeneration === undefined && read.session?.connectionOwned === true && entry(key)?.session?.connectionOwned === false)) return
      acceptRead(key, read, !current.loaded, readRevision)
      patchEntry(key, latest => ({ readTimings: { ...latest.readTimings, metadataMs: performance.now() - started } }))
    })
    const results = await Promise.allSettled([
      metadata,
      Promise.resolve().then(() => client.events(id, { limit: 120 })).then(conversationValue).then(async page => {
        if (page && !current.conversation?.nativeRef) await metadata.catch(() => undefined)
        if (!valid()) return
        if (page) {
          const conversation = entry(key)?.conversation
          if (!conversation) return
          validatePage(page, conversation)
          patchEntry(key, latest => ({ events: mergeEvents(page.events, latest.events), discussion: page.discussion ?? latest.discussion,
            page: latest.page?.beforeCursor ? { ...page, beforeCursor: latest.page.beforeCursor, hasEarlier: latest.page.hasEarlier } : page,
            ...(latest.session?.connectionGeneration !== originalGeneration && page.session.connectionGeneration !== latest.session?.connectionGeneration ? {} : { session: newerSession(latest.session, { ...page.session, events: [] }) }),
            loaded: true, readTimings: { ...latest.readTimings, historyMs: performance.now() - started } }))
        } else patchEntry(key, { loaded: true })
        if (entry(key) && submittedMessageRecorded(entry(key) as WorkspaceEntry)) { consumeSubmittedReferences(key); if (entry(key)?.action !== 'sending') patchEntry(key, { submission: undefined }) }
      })
    ])
    if (results[0].status === 'rejected') metadataError = conversationError(results[0].reason)
    if (results[1].status === 'rejected') historyError = conversationError(results[1].reason)
    if (valid()) patchEntry(key, { loadError: historyError, ...(metadataError ? { nativeError: metadataError } : {}) })
  } catch (cause) { if (valid()) patchEntry(key, { loadError: conversationError(cause) }) } finally { if (valid()) patchEntry(key, latest => ({ loading: false, readTimings: { ...latest.readTimings, totalMs: performance.now() - started } })) }

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
function submittedReferenceIds(current: WorkspaceEntry): string[] {
  const submitted = current.submission
  if (!submitted?.fileIds) return []
  if (!submitted.fileReferenceVersions) return (current.fileReferenceVersion ?? 0) === submitted.fileReferenceVersion ? submitted.fileIds : []
  return submitted.fileIds.filter(id => (current.inputReferenceVersions?.[id] ?? 0) === submitted.fileReferenceVersions?.[id])
}
function consumeSubmittedReferences(key: string): void {
  const current = entry(key)
  if (!current) return
  const consumed = submittedReferenceIds(current)
  if (!consumed.length) return
  patchEntry(key, { selectedInputIds: current.selectedInputIds?.filter(id => !consumed.includes(id)), excludedInputIds: [...new Set([...(current.excludedInputIds ?? []), ...consumed])] })
}

function submittedMessageRecorded(current: Pick<WorkspaceEntry, 'events' | 'submission'>): boolean {
  const pending = current.submission
  if (!pending) return false
  return current.events.some(event => {
    if (event.kind !== 'message' || event.payload?.role !== 'user') return false
    const action = event.payload.privateAction
    return Boolean(action && typeof action === 'object' && 'requestId' in action && action.requestId === pending.id) || Boolean(pending.turnId && event.turnId === pending.turnId)
  })
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
      reading.set(key, (reading.get(key) ?? 0) + 1); patchEntry(key, { directory, loading: false, files: [], filesLoaded: false, selectedInputIds: [], excludedInputIds: [], inputReferenceVersions: {}, fileReferenceVersion: (current.fileReferenceVersion ?? 0) + 1 }); acceptRead(key, read); void refreshFiles(key)
    } else patchEntry(key, { directory })
    if (entry(key)?.text) queueSave(key)
    return Boolean(entry(key))
  } catch (cause) { patchEntry(key, { error: conversationError(cause) }); return false }
  finally { patchEntry(key, { action: undefined }) }
}
export function selectedInputFiles(current: Pick<WorkspaceEntry, 'files' | 'selectedInputIds'>): ConversationFile[] {
  return current.files.filter(file => file.kind === 'input' && current.selectedInputIds?.includes(file.id))
}
export function referenceInputFile(key: string, fileId: string, selected: boolean): void {
  const current = entry(key)
  if (!current?.files.some(file => file.id === fileId && file.kind === 'input')) return
  patchEntry(key, value => {
    const version = (value.fileReferenceVersion ?? 0) + 1
    return { selectedInputIds: selected ? [...new Set([...(value.selectedInputIds ?? []), fileId])] : value.selectedInputIds?.filter(id => id !== fileId), excludedInputIds: selected ? value.excludedInputIds?.filter(id => id !== fileId) : [...new Set([...(value.excludedInputIds ?? []), fileId])], inputReferenceVersions: { ...value.inputReferenceVersions, [fileId]: version }, fileReferenceVersion: version, localUpdatedAt: Date.now() }
  })
}
export async function addFiles(key: string): Promise<void> {
  const current = entry(key), client = conversationClient()
  if (!current || !client || current.action) return
  patchEntry(key, { action: 'files', fileError: undefined })
  try { const conversation = await persistIdentity(key); const added = conversationValue(await client.pickFiles(conversation.id)); patchEntry(key, value => ({ inputReferenceVersions: { ...value.inputReferenceVersions, ...Object.fromEntries(added.map(file => [file.id, (value.fileReferenceVersion ?? 0) + 1])) }, selectedInputIds: [...new Set([...(value.selectedInputIds ?? []), ...added.map(file => file.id)])], fileReferenceVersion: (value.fileReferenceVersion ?? 0) + 1, excludedInputIds: value.excludedInputIds?.filter(id => !added.some(file => file.id === id)) })); await refreshFiles(key) }
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
    const previousScope = scopeKey(current.kind, current.projectId), nextScope = scopeKey(current.kind, projectId ?? undefined)
    useConversations.setState((state) => {
      const selected = { ...state.selected }
      if (previousScope !== nextScope && selected[previousScope] === key) delete selected[previousScope]
      selected[nextScope] = key
      return { selected, projectScopes: { ...state.projectScopes, [baseScopeKey(current.kind)]: projectId } }
    })
  }
  if (!current.conversation) { patchEntry(key, { projectId: projectId ?? undefined }); selectDestination(); return }
  patchEntry(key, { action: 'classify' })
  try { acceptRead(key, conversationValue(await client.reclassify(current.conversation.id, { projectId }))); if (entry(key)) selectDestination() }
  catch (cause) { patchEntry(key, { error: conversationError(cause) }) }
  finally { patchEntry(key, { action: undefined }) }
}
export async function createProject(name: string): Promise<ConversationProject> {
  const client = conversationClient()
  if (!client) throw new Error('请在桌面应用中创建会话项目。')
  const project = conversationValue(await client.createProject({ name }))
  useConversations.setState((state) => ({ projects: [...state.projects.filter((item) => item.id !== project.id), project] }))
  return project
}
export function selectArchive(id: string, kind: ConversationKind, projectId?: string): void {
  selectionRevision++
  useConversations.setState((state) => ({ selected: { ...state.selected, [scopeKey(kind, projectId)]: `archive:${id}` } }))
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
let defaultsRevision = 0
export async function refreshConversationDefaults(): Promise<void> {
  const revision = ++defaultsRevision
  const settings = await api.getSettings()
  if (revision !== defaultsRevision) return
  const choices = piModelChoices(settings.ai)
  useConversations.setState({ piModels: choices.models, defaultPiModelId: choices.defaultId })
  useApp.setState({ settings })
}
function listen(): void {
  if (listening || !hasIpc) return
  listening = true
  api.onConversationDefaultsChanged?.(() => {
    void refreshConversationDefaults().catch(cause => useConversations.setState({ runtimeError: conversationError(cause) }))
  })
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
  const readRevision = metadataRevision
  const defaultsReadRevision = defaultsRevision
  useConversations.setState({ loading: true })
  refreshing = (async (): Promise<void> => {
    const listRead = client.list({ archive: 'all' }).then(result => { if (result.ok) { acceptCatalog(result.value, readRevision); useConversations.setState({ error: undefined }) }; return result })
    const settingsRead = api.getSettings()
    const otherReads = Promise.allSettled([api.acpAgents(), api.chatList()])
    const [list, projects, settings] = await Promise.allSettled([listRead, client.projects(), settingsRead])
    if (list.status === 'fulfilled' && list.value.ok) { acceptCatalog(list.value.value, readRevision); useConversations.setState({ error: undefined }) }
    else if (list.status === 'rejected') useConversations.setState({ error: conversationError(list.reason) })
    else if (!list.value.ok) useConversations.setState({ error: list.value.error })
    if (projects.status === 'fulfilled' && projects.value.ok) useConversations.setState({ projects: projects.value.value })
    else if (projects.status === 'rejected') useConversations.setState({ error: conversationError(projects.reason) })
    else if (!projects.value.ok) useConversations.setState({ error: projects.value.error })
    if (settings.status === 'fulfilled') {
      const { models: piModels, defaultId: defaultPiModelId } = piModelChoices(settings.value.ai)
      if (defaultsReadRevision === defaultsRevision) useConversations.setState({ configuredPi: piModels.some((model) => model.available), piModels, defaultPiModelId, modelLabel: piModels.find((model) => model.id === defaultPiModelId)?.label })
      try {
        restoringStorage = true
        const nextNamespace = await installationNamespace(settings.value.bridgeToken)
        if (nativeNamespace && nativeNamespace !== nextNamespace) { preservedSnapshot = null; restoredStorageOwner = ''; unreadableStorage = '' }
        nativeNamespace = nextNamespace
        useConversations.setState((state) => ({ entries: Object.fromEntries(Object.entries(state.entries).map(([key, item]) => [key, !item.owner ? { ...item, owner: nativeNamespace } : item])) }))
        if (list.status === 'fulfilled' && list.value.ok) restoreLocalDrafts(new Set(list.value.value.map((item) => item.id)))
      } catch (cause) { useConversations.setState({ storageError: conversationError(cause) }) }
      finally { restoringStorage = false; persistLocalDrafts() }
    } else useConversations.setState({ runtimeError: conversationError(settings.reason), configuredPi: false })
    useConversations.setState({ loading: false, initialized: true })
    const [runtimes, archives] = await otherReads
    if (runtimes.status === 'fulfilled' && runtimes.value.ok) {
      const values = runtimes.value.agents ?? [], preferred = values.find((runtime) => runtime.id === 'pi' && runtime.enabled && runtime.available) ?? values.find((runtime) => runtime.enabled && runtime.available)
      useConversations.setState({ runtimes: values, defaultRuntimeId: preferred?.id, runtimeError: settings.status === 'rejected' ? conversationError(settings.reason) : undefined })
      for (const item of Object.values(useConversations.getState().entries)) if (!item.runtimeId && !item.conversation?.nativeRef) patchEntry(item.key, { runtimeId: preferred?.id })
    } else useConversations.setState({ runtimeError: runtimes.status === 'rejected' ? conversationError(runtimes.reason) : runtimes.value.error ?? '执行引擎配置无法读取。' })
    if (archives.status === 'fulfilled' && archives.value.ok) useConversations.setState({ archives: archives.value.sessions ?? [], archiveError: undefined })
    else useConversations.setState({ archiveError: archives.status === 'rejected' ? conversationError(archives.reason) : archives.value.error ?? '旧问答记录无法读取。' })
  })()
  try { await refreshing }
  catch (cause) { useConversations.setState({ loading: false, initialized: true, error: conversationError(cause) }) }
  finally { refreshing = undefined }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    persistLocalDrafts()
    for (const key of saveTimers.keys()) stopSaveTimer(key)
  })
  window.addEventListener('blur', () => {
    persistLocalDrafts()
    for (const key of saveTimers.keys()) {
      if (!entry(key)?.conversation) continue
      stopSaveTimer(key)
      void saveDraft(key).catch(() => undefined)
    }
  })
}
