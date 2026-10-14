// 状态/优先级/布局/导航签名图标：统一使用 lucide-react（ISC 许可）绘制。
import type { JSX } from 'react'
import {
  Box,
  Calendar,
  ChartColumn,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Columns3,
  Eye,
  FileText,
  ChartGantt,
  Inbox,
  LayoutDashboard,
  List,
  ListTodo,
  Minus,
  RotateCw,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Table2,
  type LucideIcon
} from 'lucide-react'
import type { Priority, StateGroup } from './types'

interface IconProps {
  className?: string
  size?: number
  color?: string
}

function Lucide({
  icon: Icon,
  size,
  className,
  color
}: IconProps & { icon: LucideIcon }): JSX.Element {
  return (
    <Icon
      size={size}
      strokeWidth={2}
      className={`shrink-0 ${className ?? ''}`}
      aria-hidden="true"
      style={color ? { color } : undefined}
    />
  )
}

/* ---------------- 状态组图标 ----------------
 * backlog：虚线圆（待定）
 * unstarted：空心圆（已排期未开始）
 * started：圆心点（进行中）
 * completed：对勾圆（已完成）
 * cancelled：叉号圆（已取消） */

const STATE_ICONS: Record<StateGroup, LucideIcon> = {
  backlog: CircleDashed,
  unstarted: Circle,
  started: CircleDot,
  completed: CircleCheck,
  cancelled: CircleX
}

export function StateGroupIcon({
  stateGroup,
  color,
  size = 14,
  className
}: IconProps & { stateGroup: StateGroup }): JSX.Element {
  return <Lucide icon={STATE_ICONS[stateGroup] ?? Circle} size={size} className={className} color={color} />
}

/* ---------------- 优先级图标 ----------------
 * urgent：圆+感叹号 / high·medium·low：信号柱梯度 / none：横杠 */

const PRIORITY_ICONS: Record<Priority, LucideIcon> = {
  urgent: CircleAlert,
  high: SignalHigh,
  medium: SignalMedium,
  low: SignalLow,
  none: Minus
}

export function PriorityIcon({ priority, size = 14, className }: IconProps & { priority: Priority }): JSX.Element {
  return <Lucide icon={PRIORITY_ICONS[priority] ?? Minus} size={size} className={className} />
}

/* ---------------- 布局切换图标 ---------------- */

const LAYOUT_ICONS: Record<string, LucideIcon> = {
  list: List,
  board: Columns3,
  spreadsheet: Table2,
  gantt: ChartGantt,
  calendar: Calendar
}

export function LayoutIcon({ layout, size = 14, className }: IconProps & { layout: string }): JSX.Element {
  return <Lucide icon={LAYOUT_ICONS[layout] ?? List} size={size} className={className} />
}

/* ---------------- 导航图标 ---------------- */

const NAV_ICONS: Record<string, LucideIcon> = {
  'your-work': LayoutDashboard,
  inbox: Inbox,
  analytics: ChartColumn,
  'work-items': ListTodo,
  cycles: RotateCw,
  modules: Box,
  views: Eye,
  pages: FileText,
  intake: CircleAlert
}

export function NavIcon({ name, size = 16, className }: IconProps & { name: string }): JSX.Element {
  return <Lucide icon={NAV_ICONS[name] ?? ListTodo} size={size} className={className} />
}

/* ---------------- 品牌 logo（自拟几何标记） ---------------- */

export function WorkspaceMark({ color, letter, size = 20 }: { color: string; letter: string; size?: number }): JSX.Element {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-[5px] font-semibold text-white"
      style={{ width: size, height: size, background: color, fontSize: size * 0.5 }}
    >
      {letter}
    </div>
  )
}
