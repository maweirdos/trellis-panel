import type { AppSlice, ToastSlice } from '../types'

let toastSeq = 1

export const toastSlice: AppSlice<ToastSlice> = (set) => ({
  toasts: [],

  pushToast: (t) => {
    const id = toastSeq++
    set((s) => ({
      toasts: [...s.toasts.filter((item) => !(
        item.kind === t.kind && item.title === t.title && item.body === t.body &&
        item.task?.projectRoot === t.task?.projectRoot && item.task?.dirName === t.task?.dirName
      )).slice(-2), { ...t, id }]
    }))
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
})
