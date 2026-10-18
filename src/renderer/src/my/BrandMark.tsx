import type { JSX } from 'react'
import { clsx } from 'clsx'
import mark from '../../../../resources/brand/mark.svg?url'

/** One vector source supplies renderer marks, favicon, tray and packaged application icons. */
export function BrandMark({ size = 22, className }: { size?: number; className?: string }): JSX.Element {
  return <span aria-hidden="true" className={clsx('my-brand-mark', className)}
    style={{ width: size, height: size, maskImage: `url("${mark}")`, WebkitMaskImage: `url("${mark}")` }} />
}
