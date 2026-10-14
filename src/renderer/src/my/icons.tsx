// 状态/优先级/布局/导航签名图标（原创绘制：以基本图元表达等价语义）。
import type { JSX } from 'react'
import type { Priority, StateGroup } from './types'

interface IconProps {
  className?: string
  size?: number
  color?: string
}

function Svg({
  className,
  size = 14,
  children
}: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className ?? ''}`}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/* ---------------- 状态组图标 ----------------
 * backlog：虚线环（仅待定）
 * unstarted：虚线环 + 细实线内环（已排期未开始）
 * started：虚线环 + 实心内点（进行中）
 * completed：实心圆 + 白色对勾
 * cancelled：实心圆 + 白色叉号
 * 虚线以 stroke-dasharray 单圆实现，段数/相位为本实现自有参数。 */

const RING_DASHARRAY = '1.15 1.36' // 周长 2π×6.5≈40.8，约 17 段

function DashedRing({ color }: { color: string }): JSX.Element {
  return (
    <circle
      cx={8}
      cy={8}
      r={6.5}
      fill="none"
      stroke={color}
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeDasharray={RING_DASHARRAY}
      transform="rotate(-90 8 8)"
    />
  )
}

export function StateGroupIcon({
  stateGroup,
  color,
  size = 14,
  className
}: IconProps & { stateGroup: StateGroup }): JSX.Element {
  const c = color ?? '#848890'

  if (stateGroup === 'completed') {
    return (
      <Svg className={className} size={size}>
        <circle cx={8} cy={8} r={7} fill={c} />
        <path
          d="M4.9 8.3 L7.1 10.4 L11.1 5.9"
          stroke="var(--my-txt-on-color, #ffffff)"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </Svg>
    )
  }

  if (stateGroup === 'cancelled') {
    return (
      <Svg className={className} size={size}>
        <circle cx={8} cy={8} r={7} fill={c} />
        <path
          d="M5.7 5.7 L10.3 10.3 M10.3 5.7 L5.7 10.3"
          stroke="var(--my-txt-on-color, #ffffff)"
          strokeWidth={1.6}
          strokeLinecap="round"
          fill="none"
        />
      </Svg>
    )
  }

  if (stateGroup === 'started') {
    return (
      <Svg className={className} size={size}>
        <DashedRing color={c} />
        <circle cx={8} cy={8} r={3.1} fill={c} />
      </Svg>
    )
  }

  if (stateGroup === 'unstarted') {
    return (
      <Svg className={className} size={size}>
        <DashedRing color={c} />
        <circle cx={8} cy={8} r={3.1} fill="none" stroke={c} strokeWidth={1.2} />
      </Svg>
    )
  }

  // backlog
  return (
    <Svg className={className} size={size}>
      <DashedRing color={c} />
    </Svg>
  )
}

/* ---------------- 优先级图标 ----------------
 * urgent：圆角方块 + 感叹号
 * high：双柱（中、高）
 * medium：三柱渐高
 * low：三柱矮柱组
 * none：单一横杠 */

export function PriorityIcon({ priority, size = 14, className }: IconProps & { priority: Priority }): JSX.Element {
  const color = `var(--my-priority-${priority})`

  if (priority === 'urgent') {
    return (
      <Svg className={className} size={size}>
        <rect x={2} y={2} width={12} height={12} rx={3.2} fill="currentColor" style={{ color }} />
        <path d="M8 4.9 V8.7" stroke="var(--my-txt-on-color, #ffffff)" strokeWidth={1.5} strokeLinecap="round" />
        <circle cx={8} cy={11.1} r={0.95} fill="var(--my-txt-on-color, #ffffff)" />
      </Svg>
    )
  }

  if (priority === 'none') {
    return (
      <Svg className={className} size={size}>
        <rect x={3.2} y={6.9} width={9.6} height={2.3} rx={1.15} fill="currentColor" style={{ color }} />
      </Svg>
    )
  }

  // 三柱：x 为柱左缘，柱宽 2.2，底部对齐 y=13.2；[柱左缘, 柱顶 y]
  const BAR_SETS: Record<string, Array<[number, number]>> = {
    high: [
      [4.4, 5.4],
      [9.4, 2.9]
    ],
    medium: [
      [1.9, 8.2],
      [6.9, 5.4],
      [11.9, 2.9]
    ],
    low: [
      [1.9, 10.4],
      [6.9, 9.4],
      [11.9, 8.4]
    ]
  }
  const bars = BAR_SETS[priority] ?? BAR_SETS.medium
  return (
    <Svg className={className} size={size}>
      {bars.map(([x, top]) => (
        <rect key={x} x={x} y={top} width={2.2} height={13.2 - top} rx={1.1} fill="currentColor" style={{ color }} />
      ))}
    </Svg>
  )
}

/* ---------------- 布局切换图标（自绘简化形） ---------------- */

function LayoutGlyph({ layout }: { layout: string }): JSX.Element {
  const s = 'var(--my-txt-primary, currentColor)'
  switch (layout) {
    case 'board': // 三列看板
      return (
        <>
          <rect x={2} y={2.5} width={3.4} height={11} rx={1} stroke={s} strokeWidth={1.2} fill="none" />
          <rect x={6.3} y={2.5} width={3.4} height={11} rx={1} stroke={s} strokeWidth={1.2} fill="none" />
          <rect x={10.6} y={2.5} width={3.4} height={11} rx={1} stroke={s} strokeWidth={1.2} fill="none" />
        </>
      )
    case 'spreadsheet': // 表格
      return (
        <>
          <rect x={2} y={2.5} width={12} height={11} rx={1.5} stroke={s} strokeWidth={1.2} fill="none" />
          <path d="M2 6.1 H14 M7 6.1 V13.5" stroke={s} strokeWidth={1.2} fill="none" />
        </>
      )
    case 'gantt': // 双时间条
      return (
        <>
          <rect x={2} y={3.6} width={8.2} height={2.8} rx={1.4} fill={s} />
          <rect x={5.8} y={9.2} width={8.2} height={2.8} rx={1.4} fill={s} />
        </>
      )
    case 'calendar': // 日历
      return (
        <>
          <rect x={2} y={3} width={12} height={11} rx={1.5} stroke={s} strokeWidth={1.2} fill="none" />
          <path d="M5.2 1.8 V4.2 M10.8 1.8 V4.2 M2 6.4 H14" stroke={s} strokeWidth={1.2} fill="none" />
        </>
      )
    default: // list 列表三行
      return <path d="M2.6 4 H13.4 M2.6 8 H13.4 M2.6 12 H13.4" stroke={s} strokeWidth={1.5} strokeLinecap="round" fill="none" />
  }
}

export function LayoutIcon({ layout, size = 14, className }: IconProps & { layout: string }): JSX.Element {
  return (
    <Svg className={className} size={size}>
      <LayoutGlyph layout={layout} />
    </Svg>
  )
}

/* ---------------- 导航图标（自绘简化形） ---------------- */

function NavGlyph({ name }: { name: string }): JSX.Element {
  const s = 'currentColor'
  switch (name) {
    case 'cycles': // 圆环 + 箭头（周期）
      return (
        <>
          <path d="M13.4 8 A5.4 5.4 0 1 1 9.6 2.8" stroke={s} strokeWidth={1.3} strokeLinecap="round" fill="none" />
          <path d="M9.2 1.6 L13.8 2.4 L11.4 6.2" stroke={s} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>
      )
    case 'modules': // 立方体（模块）
      return (
        <>
          <path d="M8 1.9 L13.6 5 V11 L8 14.1 L2.4 11 V5 Z" stroke={s} strokeWidth={1.2} strokeLinejoin="round" fill="none" />
          <path d="M2.6 5.1 L8 8 L13.4 5.1 M8 8 V13.8" stroke={s} strokeWidth={1.2} strokeLinejoin="round" fill="none" />
        </>
      )
    case 'views': // 眼睛（视图）
      return (
        <>
          <path d="M1.8 8 C3.4 5 5.6 3.6 8 3.6 C10.4 3.6 12.6 5 14.2 8 C12.6 11 10.4 12.4 8 12.4 C5.6 12.4 3.4 11 1.8 8 Z" stroke={s} strokeWidth={1.2} fill="none" />
          <circle cx={8} cy={8} r={2} stroke={s} strokeWidth={1.2} fill="none" />
        </>
      )
    case 'pages': // 文档页
      return (
        <>
          <path d="M4 2 H9.6 L12.6 5 V13.2 A0.8 0.8 0 0 1 11.8 14 H4 A0.8 0.8 0 0 1 3.2 13.2 V2.8 A0.8 0.8 0 0 1 4 2 Z" stroke={s} strokeWidth={1.2} strokeLinejoin="round" fill="none" />
          <path d="M9.4 2.2 V5.2 H12.4" stroke={s} strokeWidth={1.2} strokeLinejoin="round" fill="none" />
        </>
      )
    case 'intake': // 圆 + 感叹号（接收）
      return (
        <>
          <circle cx={8} cy={8} r={6.2} stroke={s} strokeWidth={1.2} fill="none" />
          <path d="M8 4.8 V8.4" stroke={s} strokeWidth={1.3} strokeLinecap="round" />
          <circle cx={8} cy={11} r={0.9} fill={s} />
        </>
      )
    case 'your-work': // 工作台面板
      return (
        <>
          <rect x={2} y={2.8} width={12} height={10.4} rx={1.5} stroke={s} strokeWidth={1.2} fill="none" />
          <path d="M2 6.2 H14 M6.4 6.2 V13.2" stroke={s} strokeWidth={1.2} fill="none" />
        </>
      )
    case 'inbox': // 收件托盘
      return (
        <>
          <path d="M2.4 9 V4.4 A1.6 1.6 0 0 1 4 2.8 H12 A1.6 1.6 0 0 1 13.6 4.4 V9" stroke={s} strokeWidth={1.2} fill="none" />
          <path d="M2.4 9 H5.4 A2.6 2.6 0 0 0 10.6 9 H13.6 V11.6 A1.6 1.6 0 0 1 12 13.2 H4 A1.6 1.6 0 0 1 2.4 11.6 Z" stroke={s} strokeWidth={1.2} strokeLinejoin="round" fill="none" />
        </>
      )
    default: // work-items 工作项
      return (
        <>
          <path d="M2.6 4 H13.4 M2.6 8 H13.4 M2.6 12 H9.6" stroke={s} strokeWidth={1.4} strokeLinecap="round" fill="none" />
          <circle cx={12.2} cy={12} r={1.4} fill={s} />
        </>
      )
  }
}

export function NavIcon({ name, size = 16, className }: IconProps & { name: string }): JSX.Element {
  return (
    <Svg className={className} size={size}>
      <NavGlyph name={name} />
    </Svg>
  )
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
