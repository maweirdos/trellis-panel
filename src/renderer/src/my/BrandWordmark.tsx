import type { JSX } from 'react'
import { clsx } from 'clsx'
import wordmark from '../../../../resources/brand/wordmark.svg?url'
import './brand-motion.css'

export interface BrandWordmarkProps {
  width?: number | string
  className?: string
}

/** Outlined artwork keeps the approved letterforms independent of installed fonts. */
export function BrandWordmark({ width = 112, className }: BrandWordmarkProps): JSX.Element {
  return <span aria-hidden="true" className={clsx('my-brand-wordmark', className)}
    style={{ width, maskImage: `url("${wordmark}")`, WebkitMaskImage: `url("${wordmark}")` }} />
}
