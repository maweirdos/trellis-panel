import { useLayoutEffect, type RefObject } from 'react'
import type { UiFontSize } from '../my/appearance'

export interface ComposerAutoSizeOptions {
  textareaRef: RefObject<HTMLTextAreaElement>
  value: string
  active: boolean
  ownerKey?: string | null
  status?: string
  fontSize?: UiFontSize
}

export function useComposerAutoSize({ textareaRef, value, active, ownerKey, status, fontSize }: ComposerAutoSizeOptions): void {
  useLayoutEffect(() => {
    const field = textareaRef.current
    if (!active || !field) return
    const resize = (): void => {
      field.style.height = 'auto'
      field.style.height = `${field.scrollHeight}px`
    }
    resize()
    let width = field.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const nextWidth = field.getBoundingClientRect().width
      if (nextWidth === width) return
      width = nextWidth
      resize()
    })
    observer.observe(field)
    return () => observer.disconnect()
  }, [value, ownerKey, status, active, fontSize, textareaRef])
}
