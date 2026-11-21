import { memo, useEffect, useRef, type CSSProperties, type JSX } from 'react'
import { clsx } from 'clsx'
import { coreIds, geometry, pixelTarget, type BrandMotionState } from './brand/geometry'
import { observeBrandMotion } from './brand/motion-visibility'
import './brand-motion.css'

export type { BrandMotionState } from './brand/geometry'

export interface BrandMotionProps {
  state: BrandMotionState
  /** Sixteen CSS pixels retain all sixteen child squares in the waiting row. */
  size?: number
  active?: boolean
  className?: string
  label?: string
}

/** Persistent source pixels morph through CSS; only four parent groups run a loop. */
export const BrandMotion = memo(function BrandMotion({ state, size = 24, active = true, className, label }: BrandMotionProps): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const extent = Number.isFinite(size) ? Math.max(16, size) : 24
  useEffect(() => {
    const target = ref.current
    if (!target) return
    if (!active) { target.dataset.motion = 'paused'; return }
    return observeBrandMotion(target)
  }, [active])

  return <span ref={ref} className={clsx('my-brand-motion', className)} data-state={state} data-motion="paused"
    role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}
    style={{ width: extent, height: extent }}>
    <svg viewBox={geometry.viewBox.join(' ')} width={extent} height={extent} fill="currentColor" aria-hidden="true" focusable="false"
      shapeRendering={extent <= 24 ? 'crispEdges' : 'geometricPrecision'}>
      {geometry.components.map((unit, index) => <g key={unit.id} className="my-brand-unit" data-brand-unit={unit.id}
        style={{ '--crux-load-delay': `${unit.clockwiseIndex * 400}ms`, '--crux-wait-delay': `${index * 400}ms` } as CSSProperties}>
        {unit.children.map(cell => <g key={cell.id} data-brand-cell={cell.id}>
          {cell.members.map(id => {
            const target = pixelTarget(id, unit, cell, state, extent)
            const square = <rect x={-geometry.size / 2} y={-geometry.size / 2} width={geometry.size} height={geometry.size} rx={extent <= 24 ? 0 : geometry.rx} />
            return <g key={id} data-brand-pixel={id} data-brand-visible={target.visible} className="my-brand-pixel"
              style={{ transform: `translate(${target.x}px, ${target.y}px) scale(${target.sx}, ${target.sy})`, opacity: target.visible ? 1 : 0 }}>
              {coreIds.has(id) ? <g className="my-brand-eye">{square}</g> : square}
            </g>
          })}
        </g>)}
      </g>)}
    </svg>
  </span>
})
