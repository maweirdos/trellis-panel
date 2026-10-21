import type { MaterialUpdatedEvent, ToastEvent } from './types'

/** Shared concise copy for foreground and native task-material notifications. */
export function formatMaterialToast(event: Pick<MaterialUpdatedEvent, 'title' | 'count' | 'files'>): ToastEvent {
  const names = event.files.slice(0, 2).map((file) => {
    const name = file.split(/[\\/]/).pop() || file
    return name.length > 48 ? `${name.slice(0, 32)}…${name.slice(-12)}` : name
  })
  return {
    kind: 'info',
    title: `任务更新：${event.title}`,
    body: `${event.count} 个文件已变更${names.length ? ` · ${names.join('、')}${event.count > names.length ? ' 等' : ''}` : ''}`
  }
}
