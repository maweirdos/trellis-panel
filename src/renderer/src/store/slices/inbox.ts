import type { AppSlice, InboxSlice } from '../types'
import type { InboxItem } from '../../../../shared/types'
import { loadInbox, reconcileInbox, saveInbox } from '../inbox-storage'

export const inboxSlice: AppSlice<InboxSlice> = (set, get) => ({
  inboxProjectRoot: null,
  inbox: loadInbox(null),

  setInboxProject: (projectRoot) => {
    const raw = loadInbox(projectRoot)
    const reconciled = reconcileInbox(raw, get().snapshot, projectRoot)
    set({ inboxProjectRoot: projectRoot, inbox: reconciled })
  },

  inboxAdd: (items: InboxItem[]) => {
    set((s) => {
      const next = { ...s.inbox }
      for (const it of items) {
        if (!next[it.dirName]) next[it.dirName] = { ...it, state: 'pending' }
      }
      const reconciled = reconcileInbox(next, s.snapshot, s.inboxProjectRoot)
      return { inbox: reconciled }
    })
  },

  inboxSetState: (dirName, state) => {
    set((s) => {
      const cur = s.inbox[dirName]
      if (!cur) return s
      const next = { ...s.inbox, [dirName]: { ...cur, state } }
      saveInbox(next, s.inboxProjectRoot)
      return { inbox: next }
    })
  },

  inboxRemove: (dirName) => {
    set((s) => {
      if (!s.inbox[dirName]) return s
      const next = { ...s.inbox }
      delete next[dirName]
      saveInbox(next, s.inboxProjectRoot)
      return { inbox: next }
    })
  },

  inboxAcceptAll: () => {
    set((s) => {
      const next: Record<string, typeof s.inbox[string]> = {}
      for (const [k, v] of Object.entries(s.inbox)) {
        next[k] = v.state === 'pending' ? { ...v, state: 'accepted' } : v
      }
      saveInbox(next, s.inboxProjectRoot)
      return { inbox: next }
    })
  }
})
