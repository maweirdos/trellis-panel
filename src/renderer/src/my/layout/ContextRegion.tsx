import { useLayoutEffect, useRef, type JSX, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { InteractionScope } from '../../utils/interaction-scope'
import { useSidebarWidthStyle } from './SidebarResizeHandle'

export function ContextRegion({ collapsed, children }: { collapsed: boolean; children: ReactNode }): JSX.Element {
  const regionRef = useRef<HTMLDivElement>(null)
  const sidebarStyle = useSidebarWidthStyle()
  useLayoutEffect(() => {
    const region = regionRef.current
    if (!region) return
    if (collapsed && region.contains(document.activeElement)) document.getElementById('shell-context-toggle')?.focus()
    region.toggleAttribute('inert', collapsed)
  }, [collapsed])
  return <div ref={regionRef} style={sidebarStyle} aria-hidden={collapsed || undefined}
    className={clsx('my-context-region', collapsed && 'is-collapsed')}>
    <InteractionScope active={!collapsed}>{children}</InteractionScope>
  </div>
}
