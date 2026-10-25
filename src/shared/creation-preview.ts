import type { CreationComment } from './creations'

export type PreviewMode = 'browse' | 'annotate'
export type PreviewAnchorStatus = 'located' | 'missing' | 'ambiguous'
export type CreationPreviewTarget = CreationComment['target']

/** Coordinates are clipped to the captured viewport and normalized to 0…1. */
export interface PreviewBox {
  x: number
  y: number
  width: number
  height: number
}

export interface PreviewField {
  selector?: string
  name?: string
  value: string
}

export interface PreviewContext {
  route?: string
  hash?: string
  scroll?: { x: number; y: number }
  viewport?: { width: number; height: number }
  fields?: PreviewField[]
}

/** Untrusted, bounded DOM facts. These are never instructions or an execution request. */
export type PreviewTarget = Extract<CreationPreviewTarget, { kind: 'web' }> & {
  tag?: string
  selectedText?: string
  context?: PreviewContext
}

export interface PreviewMarker {
  id: string
  label: string
  target: PreviewTarget
}

export interface PreviewInteraction {
  kind: 'ready' | 'click' | 'change' | 'escape' | 'marker-click' | 'resource-blocked' | 'navigation-blocked'
  tag?: string
  markerId?: string
}

export interface PrototypePreviewProps {
  body: string
  mode: PreviewMode
  selectedTarget?: PreviewTarget | null
  markers?: PreviewMarker[]
  onSelect(target: PreviewTarget): void
  onMarkerClick?(id: string): void
  onAnchorStatus?(status: PreviewAnchorStatus): void
  onInteraction?(event: PreviewInteraction): void
  onExitAnnotate?(): void
  title?: string
  className?: string
  minHeight?: number
}

/** Drop transient SDK-only keys before sending a strict creation command. */
export function previewTargetToCreationTarget(target: PreviewTarget): CreationPreviewTarget {
  const result = {
    kind: 'web' as const,
    ...(target.stableId ? { stableId: target.stableId } : {}),
    ...(target.selector ? { selector: target.selector } : {}),
    ...(target.role ? { role: target.role } : {}),
    ...(target.name ? { name: target.name } : {}),
    ...(target.selectedText || target.text ? { text: target.selectedText || target.text } : {}),
    ...(target.box ? { box: target.box } : {}),
    ...(target.state ? { state: target.state } : {}),
    ...(target.context ? { context: target.context } : {}),
    ...(target.screenshotRefs ? { screenshotRefs: target.screenshotRefs } : {})
  }
  return result
}

/** Non-web comments cannot be resolved against an HTML document. */
export function creationTargetToPreviewTarget(target: CreationPreviewTarget): PreviewTarget | null {
  if (target.kind !== 'web') return null
  return { ...target }
}
