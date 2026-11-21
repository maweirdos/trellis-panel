import type { CSSProperties, JSX } from 'react'
import { clsx } from 'clsx'
import mark from '../../../../resources/brand/mark.svg?url'
import compactMark from '../../../../resources/brand/mark-compact.svg?url'
import smallMark from '../../../../resources/brand/mark-16.svg?url'
import mediumMark from '../../../../resources/brand/mark-20.svg?url'
import './brand-motion.css'

export interface BrandMarkProps {
  size?: number | string
  className?: string
  /** CSS token sizes usually belong to compact navigation slots. */
  compact?: boolean
}

/** One vector source supplies renderer marks, favicon, tray and packaged application icons. */
export function BrandMark({ size = 22, className, compact = typeof size === 'string' || size <= 24 }: BrandMarkProps): JSX.Element {
  const source = !compact ? mark : typeof size === 'number' && size <= 18 ? smallMark : typeof size === 'number' && size <= 20 ? mediumMark : compactMark
  const densitySource = compact && typeof size === 'string'
  const mask = densitySource ? 'var(--crux-mark-source)' : `url("${source}")`
  const variants = densitySource ? { '--crux-mark-16': `url("${smallMark}")`, '--crux-mark-20': `url("${mediumMark}")`, '--crux-mark-24': `url("${compactMark}")` } : undefined
  return <span aria-hidden="true" className={clsx('my-brand-mark', densitySource && 'my-brand-density-mark', className)}
    style={{ ...variants, width: size, height: size, maskImage: mask, WebkitMaskImage: mask } as CSSProperties} />
}
