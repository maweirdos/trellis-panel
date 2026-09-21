import type { AppSlice, ToastSlice } from '../types'

let toastSeq = 1

export const toastSlice: AppSlice<ToastSlice> = (set, get) => ({
  toasts: [],

  pushToast: (t) => {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }))
    setTimeout(() => get().dismissToast(id), t.kind === 'error' ? 9000 : 5000)
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
})
