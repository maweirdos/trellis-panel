import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

export class PageModuleLoadError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options)
    this.name = 'PageModuleLoadError'
  }
}

export function lazyPage<Properties extends object>(load: () => Promise<{ default: ComponentType<Properties> }>): LazyExoticComponent<ComponentType<Properties>> {
  return lazy(() => load().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new PageModuleLoadError(`页面模块加载失败：${message}`, { cause })
  }))
}
