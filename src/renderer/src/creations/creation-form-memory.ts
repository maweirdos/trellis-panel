import type { CreationCommand, CreationCommandReply, CreationPrivateSource } from '@shared/creations'

export type CreationFormIdentity = {
  workspaceKey: string
  actorId: string
  epoch: string | null
  scope: 'personal' | 'team'
  spaceId: string | null
  source: CreationPrivateSource | null
}

export type RetainedCreationForm = {
  identity: CreationFormIdentity
  creationId: string
  title: string
  kind: 'prototype' | 'document'
  body: string
  privateSource?: CreationPrivateSource
  editors: string[]
  // The command owner may attach the exact admitted command, including its UUID.
  command?: Extract<CreationCommand, { action: 'create' }>
  receipt?: CreationCommandReply
  pending: boolean
  version: number
}

// Bodies and commands are deliberately kept only for the lifetime of this renderer.
// Never evict an unsaved form or an unknown operation to make room for another.
const forms = new Map<string, RetainedCreationForm>()
const listeners = new WeakMap<RetainedCreationForm, Set<() => void>>()
const listListeners = new Set<() => void>()
let listVersion = 0
const MAX_FORMS = 24

export type CreationFormOwner = Pick<CreationFormIdentity, 'workspaceKey' | 'actorId' | 'epoch' | 'scope' | 'spaceId'>

export function canAccessCreationForms(input: { state: 'local' | 'connected' | 'offline' | 'access-revoked'; actorId: string | null; epoch?: string; hasAccess: boolean; listAuthorized: boolean }): boolean {
  return Boolean(input.actorId && input.hasAccess && input.listAuthorized
    && (input.state === 'local' || (input.state === 'connected' && input.epoch)))
}

export function subscribeCreationForms(listener: () => void): () => void {
  listListeners.add(listener)
  return () => { listListeners.delete(listener) }
}

export function creationFormsVersion(): number { return listVersion }

function listChanged(): void {
  listVersion++
  listListeners.forEach((listener) => listener())
}

/** Call only after the current owner and scope have been authorized. */
export function listCreationForms(owner: CreationFormOwner): RetainedCreationForm[] {
  return [...forms.values()].filter(({ identity }) => identity.workspaceKey === owner.workspaceKey
    && identity.actorId === owner.actorId && identity.epoch === owner.epoch
    && identity.scope === owner.scope && identity.spaceId === owner.spaceId)
}

function keyOf(identity: CreationFormIdentity): string {
  const source = identity.source
  return JSON.stringify([identity.workspaceKey, identity.actorId, identity.epoch, identity.scope, identity.spaceId,
    source ? [source.conversationId, source.fileId, source.revision, source.sourceIdentity ?? null] : null])
}

export function readCreationForm(identity: CreationFormIdentity): RetainedCreationForm | undefined {
  return forms.get(keyOf(identity))
}

export function openCreationForm(identity: CreationFormIdentity, initial?: { title: string; kind: 'prototype' | 'document'; body: string; privateSource?: CreationPrivateSource }): RetainedCreationForm | undefined {
  const key = keyOf(identity)
  const existing = forms.get(key)
  if (existing) return existing
  if (forms.size >= MAX_FORMS) return undefined
  const form: RetainedCreationForm = { identity, creationId: crypto.randomUUID(), title: initial?.title ?? '', kind: initial?.kind ?? 'prototype', body: initial?.body ?? '', privateSource: initial?.privateSource, editors: [], pending: false, version: 0 }
  forms.set(key, form)
  return form
}

export function subscribeCreationForm(form: RetainedCreationForm, listener: () => void): () => void {
  const current = listeners.get(form) ?? new Set<() => void>()
  current.add(listener)
  listeners.set(form, current)
  return () => { current.delete(listener) }
}

function changed(form: RetainedCreationForm): void {
  form.version++
  listeners.get(form)?.forEach((listener) => listener())
  listChanged()
}

export function updateCreationForm(form: RetainedCreationForm, values: Partial<Pick<RetainedCreationForm, 'title' | 'kind' | 'body' | 'privateSource' | 'editors' | 'pending'>>): void {
  if (forms.get(keyOf(form.identity)) !== form) return
  Object.assign(form, values)
  changed(form)
}

/** Called by the command owner before admission, never by a different principal. */
export function retainCreationFormCommand(identity: CreationFormIdentity, command: Extract<CreationCommand, { action: 'create' }>): boolean {
  const form = readCreationForm(identity)
  if (!form || !form.pending || command.creationId !== form.creationId || form.command) return false
  form.command = structuredClone(command)
  changed(form)
  return true
}

/** Only a receipt for this exact retained command can settle the form. */
export function recordCreationFormReceipt(identity: CreationFormIdentity, receipt: CreationCommandReply): boolean {
  const form = readCreationForm(identity)
  if (!form?.pending || !form.command || receipt.commandId !== form.command.commandId
    || receipt.result.creationId !== form.creationId || receipt.result.action !== 'create') return false
  form.receipt = receipt
  changed(form)
  return true
}

/** Release only this definitely rejected or never admitted command. */
export function releaseCreationFormCommand(identity: CreationFormIdentity, commandId?: string): boolean {
  const form = readCreationForm(identity)
  if (!form?.pending || form.receipt || (commandId ? form.command?.commandId !== commandId : Boolean(form.command))) return false
  form.pending = false
  form.command = undefined
  changed(form)
  return true
}

export function discardCreationForm(form: RetainedCreationForm): void {
  const key = keyOf(form.identity)
  if (forms.get(key) === form && !form.pending) { forms.delete(key); listChanged() }
}

export function settleCreationForm(form: RetainedCreationForm): void {
  const key = keyOf(form.identity)
  if (forms.get(key) === form) { forms.delete(key); listChanged() }
}
