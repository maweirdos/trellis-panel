import type { CSSProperties } from 'react'
import { Activity, Bot, Boxes, CalendarRange, Circle, CircleAlert, CircleCheck, CircleDashed, CircleDot, CircleX, ClipboardCheck, FileText, Filter, Inbox, KanbanSquare, Layers, Link2, ListTodo, MessageSquare, Sparkles, Users, Users2, Workflow, Wrench, type LucideIcon } from 'lucide-react'
import { COLLABORATION_GLYPHS, type CollaborationIconName } from '@shared/collaboration-icons'

export type FlowIconName = CollaborationIconName

const NEUTRAL_ICONS: Record<FlowIconName, LucideIcon> = {
  overview: Boxes, spaces: Wrench, members: Users, agents: Bot, crews: Users2,
  skills: Sparkles, tasks: ListTodo, board: KanbanSquare, inbox: Inbox, triage: Filter,
  projects: Layers, iterations: CalendarRange, automations: Workflow,
  review: ClipboardCheck, done: CircleCheck, blocked: CircleAlert,
  backlog: CircleDashed, todo: Circle, in_progress: CircleDot, cancelled: CircleX,
  relation: Link2, comment: MessageSquare, activity: Activity, reports: FileText
}

/** Navigation and general UI inherit neutral ink; business state color is explicit. */
export function FlowIcon({ name, size = 20, className = '', semantic = false }: { name: FlowIconName; size?: number; className?: string; semantic?: boolean }): JSX.Element {
  if (!semantic) {
    const Icon = NEUTRAL_ICONS[name]
    return <Icon size={size} strokeWidth={2} className={`shrink-0 ${className}`} aria-hidden="true" focusable="false" data-flow-icon={name} data-flow-tone="neutral" />
  }
  const glyph = COLLABORATION_GLYPHS[name]
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"
    className={`collab-icon shrink-0 ${className}`} data-flow-icon={name} data-flow-tone="semantic"
    style={{ color: `var(--my-collab-${glyph.tone})` } as CSSProperties}>
    <path d={glyph.fill} fill="currentColor" opacity=".14" />
    <path d={glyph.path} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}
