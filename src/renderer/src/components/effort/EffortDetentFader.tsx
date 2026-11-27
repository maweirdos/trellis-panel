import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { JSX, KeyboardEvent, PointerEvent } from 'react'
import { Check, X } from 'lucide-react'
import { BrandMark } from '../../my/BrandMark'
import { PreferenceRow, PreferenceSection } from '../../pages/settings/PreferenceSection'
import {
  useCollaborationPlatform,
  type EffortEmblemStyle,
  type EffortTrackTone
} from '../../crux/collaboration-platform-store'
import {
  EFFORT_STYLE_CATALOG,
  EFFORT_STYLE_CATEGORIES,
  EFFORT_TONE_LIST,
  EFFORT_TRACK_TONES,
  findEffortStyleOption,
  isCircularAnimatedStyle,
  isClassicMinimalStyle,
  isPixelLighthouseStyle,
  useIsDarkTheme,
  type EffortStyleCategory
} from './effort-catalog'
import { drawCircularSculpture } from './effort-sculptures-draw'
import {
  PIXEL_SCENE_H,
  PIXEL_SCENE_W,
  createPixelGlassWebGLRenderer,
  drawPixelLighthouseFallback2D,
  renderPixelLighthouseScene
} from './pixel-lighthouse-engine'
import './effort-fader.css'

const FADER_SNAP_THRESHOLD = 0.6
const TRACK_PAD_PX = 16
const TRACK_PARTICLE_COUNT = 36

/* ---------------- 经典 6 款精雕 SVG 滑块 ---------------- */

function ClassicEffortEmblem({
  styleKind,
  toneKind,
  level,
  active,
  isDark
}: {
  styleKind: EffortEmblemStyle
  toneKind: EffortTrackTone
  level: number
  active: boolean
  isDark: boolean
}): JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const tone = EFFORT_TRACK_TONES[toneKind] ?? EFFORT_TRACK_TONES.obsidian
  const peak = level >= 5 && active
  const fSh = `sh-${uid}`
  const gLit = `gl-${uid}`
  const gShd = `gs-${uid}`
  const gPearl = `gp-${uid}`
  const gJewel = `gj-${uid}`
  const mClip = `mc-${uid}`
  const bClip = `bc-${uid}`
  const ink = '#141418'

  const rim = isDark
    ? (level >= 3 && active ? (peak ? tone.accentDark : tone.jewelMid) : 'rgba(20, 20, 24, 0.28)')
    : (level >= 2 && active ? (peak ? tone.accentLight : `rgba(${tone.inkRgb}, 0.72)`) : 'rgba(15, 23, 42, 0.34)')

  const orbitCol = isDark
    ? (level >= 4 ? `rgba(${tone.streakRgb}, 0.85)` : (level >= 3 ? `rgba(${tone.beamRgb}, 0.72)` : `rgba(${tone.beamRgb}, 0.45)`))
    : (level >= 4 ? `rgba(${tone.inkRgb}, 0.68)` : (level >= 3 ? `rgba(${tone.inkRgb}, 0.48)` : `rgba(${tone.inkRgb}, 0.32)`))

  const accentDot = isDark
    ? (level >= 4 ? tone.jewelTop : `rgb(${tone.beamRgb})`)
    : tone.accentLight

  const specRim = 'rgba(255,255,255,0.92)'
  const outlineStrokeWidth = isDark ? (peak ? 0.95 : 0.68) : (peak ? 1.05 : 0.85)

  if (styleKind === 'logo') {
    const logoBorder = active && level >= 2
      ? (isDark ? (peak ? tone.accentDark : tone.jewelMid) : (peak ? tone.accentLight : `rgba(${tone.inkRgb}, 0.72)`))
      : undefined
    return (
      <span
        className={`mc-emblem-logo${peak ? ' is-peak' : ''}${level >= 2 ? ' is-rich' : ''}${level <= 0 ? ' is-rest' : ''}`}
        style={logoBorder ? ({ borderColor: logoBorder } as JSX.IntrinsicElements['span']['style']) : undefined}
        aria-hidden="true"
      >
        <BrandMark size={16} compact />
      </span>
    )
  }

  const sharedDefs = (
    <defs>
      <filter id={fSh} x="-35%" y="-35%" width="170%" height="170%">
        <feDropShadow dx="0" dy="1.3" stdDeviation="1.6" floodColor="#0f172a" floodOpacity={isDark ? 0.56 : 0.18} />
      </filter>
      <linearGradient id={gLit} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#ffffff" />
        <stop offset="56%" stopColor="#f4f6f9" />
        <stop offset="100%" stopColor={isDark ? '#dde3ec' : '#d5dde8'} />
      </linearGradient>
      <linearGradient id={gShd} x1="1" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={isDark ? '#e4e9f0' : '#d6dde7'} />
        <stop offset="58%" stopColor={isDark ? '#c8d1de' : '#b7c2d2'} />
        <stop offset="100%" stopColor={isDark ? '#aeb9c9' : '#95a3b8'} />
      </linearGradient>
      <radialGradient id={gPearl} cx="34%" cy="30%" r="72%">
        <stop offset="0%" stopColor="#ffffff" />
        <stop offset="62%" stopColor="#f1f4f8" />
        <stop offset="100%" stopColor={isDark ? '#cfd7e3' : '#bfc9d8'} />
      </radialGradient>
      <radialGradient id={gJewel} cx="36%" cy="32%" r="68%">
        <stop offset="0%" stopColor={tone.jewelTop} />
        <stop offset="52%" stopColor={tone.jewelMid} />
        <stop offset="100%" stopColor={tone.jewelBot} />
      </radialGradient>
    </defs>
  )

  if (styleKind === 'crux') {
    const arm = 10.6 + level * 0.72
    const w = 3.6 + (5 - level) * 0.14
    const inArm = arm * 0.44
    const inW = w * 0.44
    const c = 18
    return (
      <svg viewBox="0 0 36 36" aria-hidden="true">
        {sharedDefs}
        {level >= 2 && (
          <g className="mc-em-spin">
            <circle cx="18" cy="18" r="14.9" fill="none" stroke={orbitCol} strokeWidth={peak ? 0.95 : 0.75} strokeDasharray={level >= 4 ? '14 5 3 5' : '16 8'} />
            <circle cx="18" cy="3.1" r={level >= 3 ? 1.05 : 0.85} fill={accentDot} opacity="0.92" />
            <circle cx="32.9" cy="18" r={level >= 3 ? 1.05 : 0.85} fill={accentDot} opacity="0.92" />
            <circle cx="18" cy="32.9" r={level >= 3 ? 1.05 : 0.85} fill={accentDot} opacity="0.92" />
            <circle cx="3.1" cy="18" r={level >= 3 ? 1.05 : 0.85} fill={accentDot} opacity="0.92" />
          </g>
        )}
        <g className="mc-em-pulse" filter={`url(#${fSh})`}>
          <path d={`M${c} ${c - arm} L${c} ${c} L${c - w} ${c - w} Z`} fill={`url(#${gLit})`} />
          <path d={`M${c} ${c - arm} L${c + w} ${c - w} L${c} ${c} Z`} fill={`url(#${gShd})`} />
          <path d={`M${c + arm} ${c} L${c} ${c} L${c + w} ${c - w} Z`} fill={`url(#${gLit})`} />
          <path d={`M${c + arm} ${c} L${c + w} ${c + w} L${c} ${c} Z`} fill={`url(#${gShd})`} />
          <path d={`M${c} ${c + arm} L${c} ${c} L${c - w} ${c + w} Z`} fill={`url(#${gLit})`} />
          <path d={`M${c} ${c + arm} L${c + w} ${c + w} L${c} ${c} Z`} fill={`url(#${gShd})`} />
          <path d={`M${c - arm} ${c} L${c} ${c} L${c - w} ${c - w} Z`} fill={`url(#${gLit})`} />
          <path d={`M${c - arm} ${c} L${c - w} ${c + w} L${c} ${c} Z`} fill={`url(#${gShd})`} />
          <line x1={c} y1={c - arm + 1} x2={c} y2={c + arm - 1} stroke={specRim} strokeWidth="0.55" opacity="0.72" />
          <line x1={c - arm + 1} y1={c} x2={c + arm - 1} y2={c} stroke={specRim} strokeWidth="0.55" opacity="0.72" />
          <path
            d={`M${c} ${c - arm} L${c + w} ${c - w} L${c + arm} ${c} L${c + w} ${c + w} L${c} ${c + arm} L${c - w} ${c + w} L${c - arm} ${c} L${c - w} ${c - w} Z`}
            fill="none"
            stroke={rim}
            strokeWidth={outlineStrokeWidth}
            strokeLinejoin="round"
          />
          {level >= 1 && !peak && (
            <>
              <path
                d={`M${c} ${c - inArm} L${c + inW} ${c - inW} L${c + inArm} ${c} L${c + inW} ${c + inW} L${c} ${c + inArm} L${c - inW} ${c + inW} L${c - inArm} ${c} L${c - inW} ${c - inW} Z`}
                fill={ink}
                opacity="0.88"
              />
              {level >= 2 && <circle cx="18" cy="18" r={level >= 4 ? 2.1 : level === 3 ? 1.75 : 1.35} fill={`url(#${gJewel})`} />}
            </>
          )}
          {peak && (
            <>
              <circle cx="18" cy="18" r="4.6" fill={ink} opacity="0.92" />
              <rect x="15.8" y="15.7" width="1.5" height="4.6" rx="0.75" fill={tone.jewelTop} />
              <rect x="18.7" y="15.7" width="1.5" height="4.6" rx="0.75" fill={tone.jewelTop} />
            </>
          )}
        </g>
      </svg>
    )
  }

  if (styleKind === 'eclipse') {
    const outerR = 12.6
    const irisR = 3.0 + level * 1.12
    const bladeStart = irisR + 0.4
    const flareCol = isDark ? (peak ? tone.accentDark : `rgb(${tone.beamRgb})`) : tone.accentLight
    return (
      <svg viewBox="0 0 36 36" aria-hidden="true">
        {sharedDefs}
        <defs>
          <clipPath id={bClip}>
            <circle cx="18" cy="18" r={outerR - 1.4} />
          </clipPath>
        </defs>
        {level >= 2 && (
          <circle className="mc-em-spin" cx="18" cy="18" r="15.1" fill="none" stroke={orbitCol} strokeWidth="0.78" strokeDasharray={level >= 3 ? '2 2.8' : '6 5'} />
        )}
        {level >= 3 && (
          <g stroke={flareCol} strokeLinecap="round" strokeWidth={peak ? 1.25 : 0.88} opacity={peak ? 0.96 : 0.78}>
            <line x1="18" y1={peak ? 1.2 : 2.2} x2="18" y2="5.2" />
            <line x1="18" y1="30.8" x2="18" y2={peak ? 34.8 : 33.8} />
            <line x1={peak ? 1.2 : 2.2} y1="18" x2="5.2" y2="18" />
            <line x1="30.8" y1="18" x2={peak ? 34.8 : 33.8} y2="18" />
          </g>
        )}
        <g className="mc-em-pulse" filter={`url(#${fSh})`}>
          <circle cx="18" cy="18" r={outerR} fill={`url(#${gPearl})`} stroke={rim} strokeWidth={peak ? 1.05 : 0.8} />
          <circle cx="18" cy="18" r={outerR - 2.1} fill="#1a1a1f" />
          <g clipPath={`url(#${bClip})`}>
            {Array.from({ length: 6 }, (_, i) => {
              const a1 = (i / 6) * Math.PI * 2 + level * 0.14
              const a2 = a1 + Math.PI / 2.6
              return (
                <line
                  key={i}
                  x1={Number((18 + Math.cos(a1) * bladeStart).toFixed(1))}
                  y1={Number((18 + Math.sin(a1) * bladeStart).toFixed(1))}
                  x2={Number((18 + Math.cos(a2) * (outerR - 1.2)).toFixed(1))}
                  y2={Number((18 + Math.sin(a2) * (outerR - 1.2)).toFixed(1))}
                  stroke={`rgba(${tone.beamRgb},0.34)`}
                  strokeWidth="0.65"
                  strokeLinecap="round"
                />
              )
            })}
          </g>
          <circle cx="18" cy="18" r={Number(irisR.toFixed(1))} fill={ink} stroke={level >= 2 ? tone.jewelMid : 'rgba(255,255,255,0.22)'} strokeWidth="0.75" />
          {level >= 2 && <circle cx="18" cy="18" r={Number(Math.max(2.0, irisR * 0.58).toFixed(1))} fill={`url(#${gJewel})`} />}
          {level >= 3 && (
            <circle
              cx={Number((18 - irisR * 0.22).toFixed(1))}
              cy={Number((18 - irisR * 0.22).toFixed(1))}
              r={Number(Math.max(0.95, irisR * 0.16).toFixed(1))}
              fill="#ffffff"
              opacity="0.92"
            />
          )}
          {peak && <path d="M18 12.2 L18.9 17.1 L23.8 18 L18.9 18.9 L18 23.8 L17.1 18.9 L12.2 18 L17.1 17.1 Z" fill="#ffffff" />}
        </g>
      </svg>
    )
  }

  if (styleKind === 'sun') {
    const rayCount = level === 0 ? 4 : level === 1 ? 8 : 12
    const coreR = 7.4 + level * 0.26
    return (
      <svg viewBox="0 0 36 36" aria-hidden="true">
        {sharedDefs}
        <g filter={`url(#${fSh})`}>
          <g className="mc-em-spin">
            {Array.from({ length: rayCount }, (_, i) => {
              const ang = (i / rayCount) * Math.PI * 2
              const isLong = i % 2 === 0
              const rIn = coreR + 1.4
              const rOut = coreR + (isLong ? 3.2 + level * 0.65 : 1.9 + level * 0.35)
              const halfW = isLong ? 0.88 : 0.56
              const perp = ang + Math.PI / 2
              const bx1 = 18 + Math.cos(ang) * rIn + Math.cos(perp) * halfW
              const by1 = 18 + Math.sin(ang) * rIn + Math.sin(perp) * halfW
              const bx2 = 18 + Math.cos(ang) * rIn - Math.cos(perp) * halfW
              const by2 = 18 + Math.sin(ang) * rIn - Math.sin(perp) * halfW
              const tx = 18 + Math.cos(ang) * rOut
              const ty = 18 + Math.sin(ang) * rOut
              const rayFill = isDark
                ? (level >= 3 ? (isLong ? tone.jewelTop : tone.accentDark) : `rgb(${tone.beamRgb})`)
                : (isLong ? tone.accentLight : `rgba(${tone.inkRgb}, 0.62)`)
              return (
                <polygon
                  key={i}
                  points={`${bx1.toFixed(1)},${by1.toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)} ${bx2.toFixed(1)},${by2.toFixed(1)}`}
                  fill={rayFill}
                  opacity={active ? (isLong ? 0.94 : 0.72) : 0.58}
                />
              )
            })}
          </g>
          <g className="mc-em-pulse">
            <circle cx="18" cy="18" r={Number(coreR.toFixed(1))} fill={`url(#${gPearl})`} stroke={rim} strokeWidth={peak ? 1.0 : 0.8} />
            <circle cx="18" cy="18" r={Number((coreR * 0.66).toFixed(1))} fill="none" stroke={tone.jewelMid} strokeWidth="0.7" opacity="0.65" />
            {level >= 2 && <circle cx="18" cy="18" r={Number((coreR * 0.38).toFixed(1))} fill={`url(#${gJewel})`} />}
          </g>
        </g>
      </svg>
    )
  }

  if (styleKind === 'moon') {
    const r = 11.4
    const cutDx = [5.2, 8.8, 12.8, 17.0, 36, 36][Math.max(0, Math.min(5, level))] ?? 12.8
    return (
      <svg viewBox="0 0 36 36" aria-hidden="true">
        {sharedDefs}
        <defs>
          <mask id={mClip}>
            <rect x="0" y="0" width="36" height="36" fill="#fff" />
            <circle cx={18 - cutDx} cy="16.5" r={r * 0.98} fill="#000" />
          </mask>
        </defs>
        {level >= 2 && (
          <circle className="mc-em-spin" cx="18" cy="18" r="15.2" fill="none" stroke={orbitCol} strokeWidth="0.78" strokeDasharray={peak ? '18 5 3 5' : '14 9'} />
        )}
        <g className="mc-em-pulse" filter={`url(#${fSh})`}>
          <circle cx="18" cy="18" r="13.0" fill={`url(#${gShd})`} stroke={rim} strokeWidth={peak ? 1.0 : 0.8} />
          <circle cx="18" cy="18" r={r} fill="#17171c" />
          {level >= 1 && level <= 3 && (
            <>
              <circle cx="12.2" cy="13.2" r="0.9" fill={tone.jewelTop} opacity="0.85" />
              {level >= 2 && <circle cx="10.4" cy="20.4" r="0.65" fill={tone.jewelTop} opacity="0.65" />}
            </>
          )}
          <circle cx="18" cy="18" r={r} fill={`url(#${gPearl})`} mask={level < 4 ? `url(#${mClip})` : undefined} />
          {level >= 2 && (
            <>
              <circle cx="20.4" cy="14.2" r="1.9" fill={tone.jewelMid} opacity="0.16" />
              <circle cx="21.8" cy="20.2" r="2.3" fill={tone.jewelMid} opacity="0.12" />
            </>
          )}
          <circle cx="18" cy="18" r={r} fill="none" stroke={`rgba(${tone.beamRgb},0.55)`} strokeWidth="0.55" />
        </g>
      </svg>
    )
  }

  // 极简星辰
  const R = 11.2 + level * 0.56
  const r = R * 0.46
  const c = 18
  const outer: Array<[number, number]> = []
  const inner: Array<[number, number]> = []
  for (let i = 0; i < 5; i++) {
    const aO = -Math.PI / 2 + (i * 2 * Math.PI) / 5
    const aI = aO + Math.PI / 5
    outer.push([c + Math.cos(aO) * R, c + Math.sin(aO) * R])
    inner.push([c + Math.cos(aI) * r, c + Math.sin(aI) * r])
  }
  const outlinePts: string[] = []
  for (let i = 0; i < 5; i++) {
    outlinePts.push(`${outer[i][0].toFixed(2)},${outer[i][1].toFixed(2)}`, `${inner[i][0].toFixed(2)},${inner[i][1].toFixed(2)}`)
  }
  return (
    <svg viewBox="0 0 36 36" aria-hidden="true">
      {sharedDefs}
      {level >= 2 && (
        <circle className="mc-em-spin" cx="18" cy="18" r="15.1" fill="none" stroke={orbitCol} strokeWidth="0.78" strokeDasharray={level >= 4 ? '14 6 3 6' : '16 10'} />
      )}
      <g className="mc-em-pulse" filter={`url(#${fSh})`}>
        {outer.map((tip, i) => {
          const prevIn = inner[(i + 4) % 5]
          const nextIn = inner[i]
          return (
            <g key={i}>
              <polygon points={`${c},${c} ${tip[0].toFixed(2)},${tip[1].toFixed(2)} ${prevIn[0].toFixed(2)},${prevIn[1].toFixed(2)}`} fill={`url(#${gLit})`} />
              <polygon points={`${c},${c} ${tip[0].toFixed(2)},${tip[1].toFixed(2)} ${nextIn[0].toFixed(2)},${nextIn[1].toFixed(2)}`} fill={`url(#${gShd})`} />
              <line x1={c} y1={c} x2={Number(tip[0].toFixed(2))} y2={Number(tip[1].toFixed(2))} stroke={specRim} strokeWidth="0.5" opacity="0.72" />
            </g>
          )
        })}
        <polygon points={outlinePts.join(' ')} fill="none" stroke={rim} strokeWidth={outlineStrokeWidth} strokeLinejoin="round" />
        {level >= 2 && !peak && (
          <circle cx="18" cy="18" r={level >= 3 ? 2.2 : 1.6} fill={`url(#${gJewel})`} stroke={ink} strokeWidth="0.55" />
        )}
        {peak && (
          <>
            <circle cx="18" cy="18" r="4.1" fill={ink} opacity="0.92" />
            <rect x="15.9" y="15.8" width="1.45" height="4.4" rx="0.72" fill={tone.jewelTop} />
            <rect x="18.65" y="15.8" width="1.45" height="4.4" rx="0.72" fill={tone.jewelTop} />
          </>
        )}
      </g>
    </svg>
  )
}

/* ---------------- 圆形动态机械滑块 Canvas ---------------- */

function CircularAnimatedEmblem({
  styleKind,
  toneKind,
  level,
  active,
  isDark,
  visualFloat,
  surgeKey,
  sizePx = 36,
  animate = true
}: {
  styleKind: EffortEmblemStyle
  toneKind: EffortTrackTone
  level: number
  active: boolean
  isDark: boolean
  visualFloat: number
  surgeKey: number
  sizePx?: number
  animate?: boolean
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef({ styleKind, toneKind, level, active, isDark, visualFloat })
  const motionRef = useRef({ prevPos: visualFloat, vx: 0, snapSpin: 0 })

  stateRef.current = { styleKind, toneKind, level, active, isDark, visualFloat }

  useEffect(() => {
    if (surgeKey > 0) motionRef.current.snapSpin = 0.01
  }, [surgeKey])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const px = Math.round(sizePx * dpr)
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px
      canvas.height = px
    }

    const paint = (tSec: number, dt: number): void => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const cur = stateRef.current
      const m = motionRef.current
      const rawVx = (cur.visualFloat - m.prevPos) / Math.max(0.008, dt)
      m.prevPos = cur.visualFloat
      m.vx += (Math.max(-1.4, Math.min(1.4, rawVx * 0.24)) - m.vx) * Math.min(1, dt * 10)
      if (m.snapSpin > 0) {
        m.snapSpin = Math.min(1, m.snapSpin + dt * 2.8)
        if (m.snapSpin >= 1) m.snapSpin = 0
      }

      const tone = EFFORT_TRACK_TONES[cur.toneKind] ?? EFFORT_TRACK_TONES.obsidian
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, sizePx, sizePx)
      drawCircularSculpture(
        ctx,
        sizePx * 0.5,
        sizePx * 0.5,
        sizePx * 0.45,
        cur.styleKind,
        cur.level,
        cur.isDark,
        cur.active,
        tone,
        tSec,
        animate ? m.vx : 0,
        animate ? m.snapSpin : 0
      )
    }

    if (!animate || !active || reduced) {
      paint(1.35, 0.016)
      return
    }

    let rafId = 0
    let lastTs = performance.now()
    const tick = (ts: number): void => {
      const dt = Math.min(0.05, Math.max(0.001, (ts - lastTs) / 1000))
      lastTs = ts
      if (!document.hidden) paint(ts / 1000, dt)
      rafId = window.requestAnimationFrame(tick)
    }
    rafId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(rafId)
  }, [active, animate, isDark, level, sizePx, styleKind, toneKind])

  return (
    <canvas
      ref={canvasRef}
      className="ef-circular-canvas"
      style={{ width: sizePx, height: sizePx }}
      aria-hidden="true"
    />
  )
}

/* ---------------- 像素灯塔水晶球缩略预览徽章（用于弹层与设置页卡片） ---------------- */

function PixelLighthouseMiniBadge({ sizePx = 28 }: { sizePx?: number }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.round(sizePx * dpr)
    const h = Math.round(sizePx * dpr)
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const art = document.createElement('canvas')
    art.width = PIXEL_SCENE_W
    art.height = PIXEL_SCENE_H
    const actx = art.getContext('2d')
    if (!actx) return
    renderPixelLighthouseScene(actx, 0.72, 1.8)

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.beginPath()
    ctx.arc(sizePx * 0.5, sizePx * 0.5, sizePx * 0.46, 0, Math.PI * 2)
    ctx.clip()
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(art, 12, 0, 42, PIXEL_SCENE_H, 0, 0, sizePx, sizePx)

    const g = ctx.createRadialGradient(sizePx * 0.34, sizePx * 0.3, sizePx * 0.05, sizePx * 0.5, sizePx * 0.5, sizePx * 0.48)
    g.addColorStop(0, 'rgba(255,255,255,0.68)')
    g.addColorStop(0.45, 'rgba(255,255,255,0.06)')
    g.addColorStop(1, 'rgba(94,234,212,0.52)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, sizePx, sizePx)
  }, [sizePx])

  return <canvas ref={canvasRef} style={{ width: sizePx, height: sizePx, display: 'block' }} aria-hidden="true" />
}

/** 统一预览图标（支持全部 20 款样式，弹层/设置页零性能负担） */
export function EffortStylePreviewBadge({
  styleKind,
  toneKind,
  isDark,
  sizePx = 28,
  live = false
}: {
  styleKind: EffortEmblemStyle
  toneKind: EffortTrackTone
  isDark: boolean
  sizePx?: number
  live?: boolean
}): JSX.Element {
  if (isClassicMinimalStyle(styleKind)) {
    const tone = EFFORT_TRACK_TONES[toneKind] ?? EFFORT_TRACK_TONES.obsidian
    const accent = isDark ? tone.accentDark : tone.accentLight
    const pillBg = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 42, 0.06)'
    const pillStroke = isDark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(15, 23, 42, 0.14)'
    const thumbFill = isDark ? '#2a2f3a' : '#ffffff'
    const thumbStroke = isDark ? 'rgba(255, 255, 255, 0.24)' : 'rgba(15, 23, 42, 0.14)'
    const tickCol = isDark ? 'rgba(255, 255, 255, 0.34)' : 'rgba(15, 23, 42, 0.28)'
    return (
      <svg viewBox="0 0 28 28" width={sizePx} height={sizePx} aria-hidden="true">
        <rect x="1.5" y="8" width="25" height="12" rx="6" fill={pillBg} stroke={pillStroke} strokeWidth="1" />
        <line x1="6.5" y1="8.5" x2="6.5" y2="10.2" stroke={tickCol} strokeWidth="0.9" />
        <line x1="6.5" y1="17.8" x2="6.5" y2="19.5" stroke={tickCol} strokeWidth="0.9" />
        <line x1="21.5" y1="8.5" x2="21.5" y2="10.2" stroke={tickCol} strokeWidth="0.9" />
        <line x1="21.5" y1="17.8" x2="21.5" y2="19.5" stroke={tickCol} strokeWidth="0.9" />
        <rect x="9.5" y="9.6" width="9" height="8.8" rx="3" fill={thumbFill} stroke={thumbStroke} strokeWidth="0.9" />
        <rect x="12" y="13.2" width="4" height="1.6" rx="0.8" fill={accent} />
      </svg>
    )
  }
  if (isPixelLighthouseStyle(styleKind)) {
    return <PixelLighthouseMiniBadge sizePx={sizePx} />
  }
  if (isCircularAnimatedStyle(styleKind)) {
    return (
      <CircularAnimatedEmblem
        styleKind={styleKind}
        toneKind={toneKind}
        level={3}
        active
        isDark={isDark}
        visualFloat={3}
        surgeKey={0}
        sizePx={sizePx}
        animate={live}
      />
    )
  }
  return <ClassicEffortEmblem styleKind={styleKind} toneKind={toneKind} level={3} active isDark={isDark} />
}

/* ---------------- 方案 A 光学背景轨 Canvas ---------------- */

function KineticTrackCanvas({
  count,
  targetIdx,
  visualFloat,
  active,
  toneKind,
  surgeKey,
  isDark
}: {
  count: number
  targetIdx: number
  visualFloat: number
  active: boolean
  toneKind: EffortTrackTone
  surgeKey: number
  isDark: boolean
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const propsRef = useRef({ count, targetIdx, visualFloat, active, toneKind, isDark })
  const boostRef = useRef(0)

  propsRef.current = { count, targetIdx, visualFloat, active, toneKind, isDark }

  useEffect(() => {
    if (surgeKey > 0) boostRef.current = 1
  }, [surgeKey])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const particles = Array.from({ length: TRACK_PARTICLE_COUNT }, (_, i) => {
      const depth = 0.35 + ((i * 37) % 65) / 100
      const u1 = ((i * 53 + 11) % 97) / 97
      const u2 = ((i * 29 + 37) % 89) / 89
      return {
        x: ((i * 71) % 100) / 100,
        yNorm: 0.16 + ((u1 + u2) / 2) * 0.68,
        depth,
        tinted: i % 3 !== 0,
        phase: i * 0.8
      }
    })

    const calcLevel = (idx: number, n: number): number => (n <= 1 ? 2 : Math.round((idx / (n - 1)) * 5))
    let smoothLv = calcLevel(propsRef.current.targetIdx, propsRef.current.count)
    let smoothPos = propsRef.current.visualFloat
    let rafId = 0
    let lastTs = performance.now()

    const draw = (dt: number, ts: number, animateParticles: boolean): void => {
      const { count: n, targetIdx: idx, visualFloat: vf, active: isActive, toneKind: curTone, isDark: darkNow } = propsRef.current
      const tone = EFFORT_TRACK_TONES[curTone] ?? EFFORT_TRACK_TONES.obsidian
      const targetLv = calcLevel(idx, n)
      if (animateParticles) {
        smoothLv += (targetLv - smoothLv) * Math.min(1, dt * 7)
        smoothPos += (vf - smoothPos) * Math.min(1, dt * 18)
        boostRef.current *= Math.exp(-dt * 3.5)
      } else {
        smoothLv = targetLv
        smoothPos = vf
      }

      const rect = canvas.getBoundingClientRect()
      const w = Math.floor(rect.width)
      const h = Math.floor(rect.height)
      if (w < 24 || h < 12) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const cw = Math.round(w * dpr)
      const ch = Math.round(h * dpr)
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw
        canvas.height = ch
      }

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const pad = h * 0.5
      const span = Math.max(1, w - pad * 2)
      const xFor = (f: number): number => pad + (n > 1 ? (f / (n - 1)) * span : span * 0.5)
      const thumbX = xFor(smoothPos)
      const cy = h * 0.5
      const lv = Math.max(0, smoothLv)
      const fillEnd = Math.min(w, thumbX + pad)
      const startX = xFor(0)

      if (isActive && lv > 0.15) {
        const grad = ctx.createLinearGradient(0, 0, fillEnd, 0)
        if (darkNow) {
          const a = 0.09 + (lv / 5) * 0.27
          grad.addColorStop(0, `rgba(${tone.darkGlowRgb}, ${(a * 0.14).toFixed(3)})`)
          grad.addColorStop(0.5, `rgba(${tone.darkGlowRgb}, ${(a * 0.52).toFixed(3)})`)
          grad.addColorStop(1, `rgba(${tone.darkGlowRgb}, ${a.toFixed(3)})`)
        } else {
          const t = Math.min(1, lv / 5)
          grad.addColorStop(0, `rgba(${tone.mistRgb}, ${(0.03 + t * 0.02).toFixed(3)})`)
          grad.addColorStop(0.48, `rgba(${tone.mistRgb}, ${(0.08 + t * 0.1).toFixed(3)})`)
          grad.addColorStop(0.88, `rgba(${tone.mistRgb}, ${(0.14 + t * 0.14).toFixed(3)})`)
          grad.addColorStop(1, `rgba(${tone.mistRgb}, ${(0.17 + t * 0.14).toFixed(3)})`)
        }
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.roundRect(0, 0, fillEnd, h, pad)
        ctx.fill()
      } else if (!isActive && idx > 0) {
        ctx.fillStyle = darkNow ? `rgba(${tone.darkGlowRgb}, 0.08)` : tone.idleFillLight
        ctx.beginPath()
        ctx.roundRect(0, 0, fillEnd, h, pad)
        ctx.fill()
      }

      for (let i = 0; i < n; i++) {
        const tx = xFor(i)
        ctx.fillStyle = darkNow ? `rgba(${tone.beamRgb}, 0.34)` : 'rgba(15, 23, 42, 0.22)'
        ctx.fillRect(Math.round(tx) - 0.5, 2, 1, 3.2)
        ctx.fillRect(Math.round(tx) - 0.5, h - 5.2, 1, 3.2)
        if (Math.abs(tx - thumbX) > 15) {
          ctx.fillStyle = darkNow ? `rgba(${tone.beamRgb}, 0.52)` : 'rgba(15, 23, 42, 0.26)'
          ctx.beginPath()
          ctx.arc(tx, cy, 1.25, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      if (!isActive) return

      if (darkNow) {
        ctx.globalCompositeOperation = 'lighter'
        const coreRgb = tone.beamRgb
        const tintRgb = tone.streakRgb

        if (lv > 0.6) {
          const r = 18 + lv * 8
          const bloomA = 0.28 * (lv / 5)
          const rg = ctx.createRadialGradient(thumbX, cy, 2, thumbX, cy, r)
          rg.addColorStop(0, `rgba(${tintRgb}, ${bloomA.toFixed(3)})`)
          rg.addColorStop(0.55, `rgba(${coreRgb}, ${(bloomA * 0.32).toFixed(3)})`)
          rg.addColorStop(1, `rgba(${coreRgb}, 0)`)
          ctx.fillStyle = rg
          ctx.fillRect(0, 0, w, h)
        }

        if (lv > 0.3 && thumbX > startX + 8) {
          const beamA = Math.min(0.96, 0.4 + lv * 0.12)
          const gOut = ctx.createLinearGradient(startX, cy, thumbX, cy)
          gOut.addColorStop(0, `rgba(${tintRgb}, 0)`)
          gOut.addColorStop(0.55, `rgba(${tintRgb}, ${(beamA * 0.2).toFixed(3)})`)
          gOut.addColorStop(1, `rgba(${tintRgb}, ${(beamA * 0.38).toFixed(3)})`)
          ctx.fillStyle = gOut
          const gh = 1.0 + lv * 0.48
          ctx.beginPath()
          ctx.moveTo(startX, cy - 0.35)
          ctx.lineTo(thumbX, cy - gh)
          ctx.lineTo(thumbX, cy + gh)
          ctx.lineTo(startX, cy + 0.35)
          ctx.closePath()
          ctx.fill()

          const gCore = ctx.createLinearGradient(startX, cy, thumbX, cy)
          gCore.addColorStop(0, `rgba(${coreRgb}, ${(beamA * 0.28).toFixed(3)})`)
          gCore.addColorStop(0.45, `rgba(${coreRgb}, ${(beamA * 0.84).toFixed(3)})`)
          gCore.addColorStop(1, `rgba(${coreRgb}, ${beamA.toFixed(3)})`)
          ctx.fillStyle = gCore
          const chHalf = 0.42 + lv * 0.23
          ctx.beginPath()
          ctx.moveTo(startX, cy - 0.3)
          ctx.lineTo(thumbX, cy - chHalf)
          ctx.lineTo(thumbX, cy + chHalf)
          ctx.lineTo(startX, cy + 0.3)
          ctx.closePath()
          ctx.fill()

          ctx.fillStyle = `rgba(${coreRgb}, ${Math.min(0.92, 0.5 + lv * 0.1).toFixed(3)})`
          ctx.beginPath()
          ctx.arc(startX, cy, 1.5, 0, Math.PI * 2)
          ctx.fill()
        }

        if (animateParticles) {
          const activeCount = Math.round(6 + (lv / 5) * (TRACK_PARTICLE_COUNT - 6))
          const speedBase = (8 + Math.pow(lv, 2.3) * 11) * (1 + boostRef.current * 1.8)
          const lenBase = 1.4 + Math.pow(lv, 1.9) * 2.4
          const fieldRight = lv >= 4 ? w : Math.max(thumbX + 18, w * 0.55)

          for (let i = 0; i < activeCount; i++) {
            const p = particles[i]
            p.x = (p.x + (speedBase * (0.48 + p.depth * 0.88) * dt) / Math.max(60, w)) % 1.2
            const headX = p.x * (fieldRight + 22) - 10
            const y = p.yNorm * h
            const behindThumb = headX <= thumbX + 4
            const len = behindThumb ? Math.min(w * 0.42, lenBase * (0.45 + p.depth * 0.85)) : Math.min(6, 1.1 + lv * 0.7)
            const tailX = headX - len
            const fadeL = Math.min(1, Math.max(0, headX / 18))
            const fadeR = behindThumb
              ? Math.min(1, Math.max(0, (thumbX + 8 - tailX) / 14))
              : Math.min(1, Math.max(0, (w - headX) / 16)) * 0.42
            const twinkle = 0.74 + 0.26 * Math.sin(ts * 0.0045 + p.phase)
            const alpha = fadeL * fadeR * twinkle * (0.3 + (lv / 5) * 0.66) * p.depth
            if (alpha < 0.02) continue

            const rgb = p.tinted ? tintRgb : coreRgb
            if (len <= 2.4) {
              ctx.fillStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`
              ctx.beginPath()
              ctx.arc(headX, y, 0.75 + p.depth * 0.5, 0, Math.PI * 2)
              ctx.fill()
            } else {
              const lg = ctx.createLinearGradient(tailX, y, headX, y)
              lg.addColorStop(0, `rgba(${rgb}, 0)`)
              lg.addColorStop(0.68, `rgba(${rgb}, ${(alpha * 0.78).toFixed(3)})`)
              lg.addColorStop(1, `rgba(${rgb}, ${alpha.toFixed(3)})`)
              ctx.strokeStyle = lg
              ctx.lineWidth = 0.65 + p.depth * (0.35 + lv * 0.1)
              ctx.lineCap = 'round'
              ctx.beginPath()
              ctx.moveTo(tailX, y)
              ctx.lineTo(headX, y)
              ctx.stroke()
            }
          }
        }
        ctx.globalCompositeOperation = 'source-over'
      } else {
        const inkRgb = tone.inkRgb
        const mistRgb = tone.mistRgb

        if (lv > 0.6) {
          const r = 18 + lv * 6.5
          const auraA = 0.16 * (lv / 5)
          const rg = ctx.createRadialGradient(thumbX, cy, 3, thumbX, cy, r)
          rg.addColorStop(0, `rgba(${mistRgb}, ${auraA.toFixed(3)})`)
          rg.addColorStop(0.6, `rgba(${mistRgb}, ${(auraA * 0.35).toFixed(3)})`)
          rg.addColorStop(1, `rgba(${mistRgb}, 0)`)
          ctx.fillStyle = rg
          ctx.fillRect(0, 0, w, h)
        }

        if (lv > 0.3 && thumbX > startX + 8) {
          const beamA = Math.min(0.88, 0.36 + lv * 0.11)
          const gOut = ctx.createLinearGradient(startX, cy, thumbX, cy)
          gOut.addColorStop(0, `rgba(${mistRgb}, 0)`)
          gOut.addColorStop(0.55, `rgba(${mistRgb}, ${(beamA * 0.16).toFixed(3)})`)
          gOut.addColorStop(1, `rgba(${mistRgb}, ${(beamA * 0.3).toFixed(3)})`)
          ctx.fillStyle = gOut
          const gh = 1.1 + lv * 0.42
          ctx.beginPath()
          ctx.moveTo(startX, cy - 0.3)
          ctx.lineTo(thumbX, cy - gh)
          ctx.lineTo(thumbX, cy + gh)
          ctx.lineTo(startX, cy + 0.3)
          ctx.closePath()
          ctx.fill()

          const gCore = ctx.createLinearGradient(startX, cy, thumbX, cy)
          gCore.addColorStop(0, `rgba(${inkRgb}, ${(beamA * 0.24).toFixed(3)})`)
          gCore.addColorStop(0.45, `rgba(${inkRgb}, ${(beamA * 0.76).toFixed(3)})`)
          gCore.addColorStop(1, `rgba(${inkRgb}, ${beamA.toFixed(3)})`)
          ctx.fillStyle = gCore
          const chHalf = 0.4 + lv * 0.17
          ctx.beginPath()
          ctx.moveTo(startX, cy - 0.25)
          ctx.lineTo(thumbX, cy - chHalf)
          ctx.lineTo(thumbX, cy + chHalf)
          ctx.lineTo(startX, cy + 0.25)
          ctx.closePath()
          ctx.fill()

          ctx.fillStyle = `rgba(${inkRgb}, ${Math.min(0.75, 0.38 + lv * 0.08).toFixed(3)})`
          ctx.beginPath()
          ctx.arc(startX, cy, 1.5, 0, Math.PI * 2)
          ctx.fill()
        }

        if (animateParticles) {
          const activeCount = Math.round(5 + (lv / 5) * (TRACK_PARTICLE_COUNT - 10))
          const speedBase = (7 + Math.pow(lv, 2.2) * 10) * (1 + boostRef.current * 1.7)
          const lenBase = 1.4 + Math.pow(lv, 1.85) * 2.1
          const fieldRight = Math.max(thumbX + 10, startX + 24)

          for (let i = 0; i < activeCount; i++) {
            const p = particles[i]
            p.x = (p.x + (speedBase * (0.48 + p.depth * 0.85) * dt) / Math.max(60, w)) % 1.18
            const headX = p.x * (fieldRight + 16) - 8
            if (headX > thumbX + 2) continue
            const y = p.yNorm * h
            const len = Math.min(w * 0.36, lenBase * (0.45 + p.depth * 0.82))
            const tailX = headX - len
            const posRamp = 0.35 + 0.65 * Math.min(1, headX / Math.max(1, thumbX))
            const fadeL = Math.min(1, Math.max(0, headX / 16))
            const fadeR = Math.min(1, Math.max(0, (thumbX + 6 - tailX) / 14))
            const twinkle = 0.76 + 0.24 * Math.sin(ts * 0.0042 + p.phase)
            const alpha = posRamp * fadeL * fadeR * twinkle * (0.18 + (lv / 5) * 0.44) * p.depth
            if (alpha < 0.02) continue

            const rgb = p.tinted ? inkRgb : mistRgb
            if (len <= 2.3) {
              ctx.fillStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`
              ctx.beginPath()
              ctx.arc(headX, y, 0.7 + p.depth * 0.45, 0, Math.PI * 2)
              ctx.fill()
            } else {
              const lg = ctx.createLinearGradient(tailX, y, headX, y)
              lg.addColorStop(0, `rgba(${rgb}, 0)`)
              lg.addColorStop(0.7, `rgba(${rgb}, ${(alpha * 0.75).toFixed(3)})`)
              lg.addColorStop(1, `rgba(${rgb}, ${alpha.toFixed(3)})`)
              ctx.strokeStyle = lg
              ctx.lineWidth = 0.55 + p.depth * (0.28 + lv * 0.08)
              ctx.lineCap = 'round'
              ctx.beginPath()
              ctx.moveTo(tailX, y)
              ctx.lineTo(headX, y)
              ctx.stroke()
            }
          }
        }
      }
    }

    if (!active || reduced) {
      draw(0, performance.now(), false)
      const observer = new ResizeObserver(() => draw(0, performance.now(), false))
      observer.observe(canvas)
      return () => observer.disconnect()
    }

    const tick = (ts: number): void => {
      const dt = Math.min(0.05, Math.max(0.001, (ts - lastTs) / 1000))
      lastTs = ts
      if (!document.hidden) draw(dt, ts, true)
      rafId = window.requestAnimationFrame(tick)
    }
    rafId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(rafId)
  }, [active, count, isDark, targetIdx, toneKind, visualFloat])

  return <canvas ref={canvasRef} className="mc-ktrack-canvas" aria-hidden="true" />
}

/* ---------------- 像素灯塔水晶球全境轨（激活行独占 WebGL2，非激活行零 WebGL 静态蓝图） ---------------- */

function PixelLighthouseTrackCanvas({
  count,
  visualFloat,
  active,
  isDark
}: {
  count: number
  visualFloat: number
  active: boolean
  isDark: boolean
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const propsRef = useRef({ count, visualFloat, active, isDark })
  propsRef.current = { count, visualFloat, active, isDark }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const art = document.createElement('canvas')
    art.width = PIXEL_SCENE_W
    art.height = PIXEL_SCENE_H
    const actx = art.getContext('2d')
    if (!actx) return

    const norm = (vf: number, n: number): number => (n > 1 ? Math.max(0, Math.min(1, vf / (n - 1))) : 0.5)

    // 非激活行：仅绘制轻量 2D 像素蓝图，不占用任何 WebGL 上下文
    if (!active) {
      const drawStatic = (): void => {
        const cur = propsRef.current
        const p = norm(cur.visualFloat, cur.count)
        renderPixelLighthouseScene(actx, p, 1.2)
        drawPixelLighthouseFallback2D(canvas, art, p, cur.count, false, cur.isDark)
      }
      drawStatic()
      const ro = new ResizeObserver(drawStatic)
      ro.observe(canvas)
      return () => ro.disconnect()
    }

    // 激活行：优先使用真 3D 球面折射 WebGL2 着色器，无 WebGL2 自动回退 2D
    const glRenderer = createPixelGlassWebGLRenderer(canvas)
    let smoothPos = norm(propsRef.current.visualFloat, propsRef.current.count)

    const paint = (sec: number, dt: number): void => {
      const cur = propsRef.current
      const target = norm(cur.visualFloat, cur.count)
      smoothPos = reduced ? target : smoothPos + (target - smoothPos) * Math.min(1, dt * 11)
      renderPixelLighthouseScene(actx, smoothPos, sec)
      if (glRenderer) {
        glRenderer.draw(art, smoothPos, smoothPos, cur.count, true, cur.isDark)
      } else {
        drawPixelLighthouseFallback2D(canvas, art, smoothPos, cur.count, true, cur.isDark)
      }
    }

    if (reduced) {
      paint(1.8, 0.016)
      const ro = new ResizeObserver(() => paint(1.8, 0.016))
      ro.observe(canvas)
      return () => {
        ro.disconnect()
        glRenderer?.dispose()
      }
    }

    let rafId = 0
    let lastTs = performance.now()
    const tick = (ts: number): void => {
      const dt = Math.min(0.05, Math.max(0.001, (ts - lastTs) / 1000))
      lastTs = ts
      if (!document.hidden) paint(ts / 1000, dt)
      rafId = window.requestAnimationFrame(tick)
    }
    rafId = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(rafId)
      glRenderer?.dispose()
    }
  }, [active, count, isDark])

  return (
    <canvas
      key={active ? 'gl-live' : '2d-idle'}
      ref={canvasRef}
      className="mc-ktrack-canvas"
      aria-hidden="true"
    />
  )
}

/* ---------------- 生产级思考深度滑块组件 ---------------- */

export interface EffortDetentFaderProps {
  modelName: string
  ariaLabel?: string
  choices: ReadonlyArray<{ value: string; label: string }>
  selectedIndex: number
  active: boolean
  disabled?: boolean
  emblemStyle: EffortEmblemStyle
  trackTone: EffortTrackTone
  isDark?: boolean
  onSelect: (value: string) => void
  onHoverPreview?: (label: string | null, isPeak: boolean) => void
  onDragStateChange?: (dragging: boolean) => void
}

export function EffortDetentFader({
  modelName,
  ariaLabel,
  choices,
  selectedIndex,
  active,
  disabled = false,
  emblemStyle,
  trackTone,
  isDark: isDarkProp,
  onSelect,
  onHoverPreview,
  onDragStateChange
}: EffortDetentFaderProps): JSX.Element {
  const autoDark = useIsDarkTheme()
  const isDark = isDarkProp ?? autoDark
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; moved: boolean; seatedIdx: number } | null>(null)
  const dragCallbackRef = useRef(onDragStateChange)
  dragCallbackRef.current = onDragStateChange
  const snapTimerRef = useRef<number | null>(null)
  const lastHoverIdxRef = useRef(0)
  const [dragVisual, setDragVisual] = useState<{ visualFloat: number; seatedIdx: number } | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [snapped, setSnapped] = useState(false)
  const [surgeKey, setSurgeKey] = useState(0)

  useEffect(() => () => {
    if (snapTimerRef.current !== null) window.clearTimeout(snapTimerRef.current)
    if (dragRef.current) {
      dragRef.current = null
      dragCallbackRef.current?.(false)
    }
  }, [])

  const triggerSnap = useCallback(() => {
    setSnapped(false)
    setSurgeKey((k) => k + 1)
    if (snapTimerRef.current !== null) window.clearTimeout(snapTimerRef.current)
    window.requestAnimationFrame(() => {
      setSnapped(true)
      snapTimerRef.current = window.setTimeout(() => {
        setSnapped(false)
        snapTimerRef.current = null
      }, 260)
    })
  }, [])

  const n = choices.length
  const safeSelected = Math.max(0, Math.min(n - 1, selectedIndex))
  const isDragging = dragVisual !== null
  const visualFloat = dragVisual ? dragVisual.visualFloat : safeSelected
  const seatedIdx = dragVisual ? dragVisual.seatedIdx : safeSelected
  const level = n > 1 ? Math.round((seatedIdx / (n - 1)) * 5) : 2
  const isClassic = isClassicMinimalStyle(emblemStyle)
  const isScenic = isPixelLighthouseStyle(emblemStyle)
  const isCircular = isCircularAnimatedStyle(emblemStyle)
  const toneSpec = EFFORT_TRACK_TONES[trackTone] ?? EFFORT_TRACK_TONES.obsidian
  const toneAccent = isDark ? toneSpec.accentDark : toneSpec.accentLight

  const posCss = (f: number): string => {
    const ratio = n > 1 ? f / (n - 1) : 0.5
    return `calc(${TRACK_PAD_PX}px + (100% - ${TRACK_PAD_PX * 2}px) * ${ratio.toFixed(4)})`
  }

  const stopRatio = (f: number): number => (n > 1 ? f / (n - 1) : 0.5)

  const pointerStop = (clientX: number): { raw: number; idx: number } => {
    const el = trackRef.current
    if (!el || n <= 1) return { raw: 0, idx: 0 }
    const r = el.getBoundingClientRect()
    if (isClassic) {
      const innerW = Math.max(1, r.width - 4)
      const thumbW = Math.min(innerW / n, 78)
      const usableSpan = Math.max(1, innerW - thumbW)
      const xInInner = clientX - r.left - 2
      const f = ((xInInner - thumbW * 0.5) / usableSpan) * (n - 1)
      const raw = Math.max(0, Math.min(n - 1, f))
      return { raw, idx: Math.max(0, Math.min(n - 1, Math.round(raw))) }
    }
    const span = Math.max(1, r.width - TRACK_PAD_PX * 2)
    const f = ((clientX - r.left - TRACK_PAD_PX) / span) * (n - 1)
    return {
      raw: Math.max(0, Math.min(n - 1, f)),
      idx: Math.max(0, Math.min(n - 1, Math.round(f)))
    }
  }

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (disabled || e.button !== 0 || n <= 0) return
    e.preventDefault()
    const el = trackRef.current
    if (el) el.setPointerCapture(e.pointerId)
    setHoverIdx(null)
    onHoverPreview?.(null, false)
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, moved: false, seatedIdx: safeSelected }
    dragCallbackRef.current?.(true)
    setDragVisual({ visualFloat: safeSelected, seatedIdx: safeSelected })
  }

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (disabled) return
    const { raw, idx } = pointerStop(e.clientX)
    const d = dragRef.current
    if (d && e.pointerId === d.pointerId) {
      if (Math.abs(e.clientX - d.startX) > 5) d.moved = true
      if (!d.moved) return
      const delta = raw - d.seatedIdx
      if (Math.abs(delta) >= FADER_SNAP_THRESHOLD) {
        const nextIdx = Math.max(0, Math.min(n - 1, d.seatedIdx + Math.sign(delta)))
        if (nextIdx !== d.seatedIdx) {
          d.seatedIdx = nextIdx
          setDragVisual({ visualFloat: nextIdx, seatedIdx: nextIdx })
          triggerSnap()
          const target = choices[nextIdx]
          if (target) onSelect(target.value)
          return
        }
      }
      const tension = Math.min(1, Math.abs(delta) / FADER_SNAP_THRESHOLD)
      const nextVisual = Math.max(0, Math.min(n - 1, d.seatedIdx + Math.sign(delta) * Math.pow(tension, 1.5) * 0.24))
      setDragVisual({ visualFloat: nextVisual, seatedIdx: d.seatedIdx })
      return
    }

    if (idx !== safeSelected) {
      setHoverIdx(idx)
      onHoverPreview?.(choices[idx]?.label ?? null, n > 1 && idx === n - 1)
    } else {
      setHoverIdx(null)
      onHoverPreview?.(null, false)
    }
  }

  const handlePointerLeave = (): void => {
    setHoverIdx(null)
    onHoverPreview?.(null, false)
  }

  const finishPointer = (e: PointerEvent<HTMLDivElement>, commitClick: boolean): void => {
    const d = dragRef.current
    const el = trackRef.current
    if (!d || e.pointerId !== d.pointerId) return
    const wasMoved = d.moved
    dragRef.current = null
    dragCallbackRef.current?.(false)
    setDragVisual(null)
    if (el && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)

    if (!disabled && commitClick && !wasMoved) {
      const { idx } = pointerStop(e.clientX)
      const target = choices[idx]
      if (target) {
        if (idx !== safeSelected || !active) triggerSnap()
        onSelect(target.value)
      }
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    let nextIdx = safeSelected
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nextIdx = Math.min(n - 1, safeSelected + 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') nextIdx = Math.max(0, safeSelected - 1)
    else if (e.key === 'Home') nextIdx = 0
    else if (e.key === 'End') nextIdx = n - 1
    else return
    e.preventDefault()
    if (nextIdx !== safeSelected || !active) {
      triggerSnap()
      const target = choices[nextIdx]
      if (target) onSelect(target.value)
    }
  }

  const showReticle = !disabled && hoverIdx !== null && !isDragging
  if (hoverIdx !== null) lastHoverIdxRef.current = hoverIdx
  const hoverAnchorIdx = Math.max(0, Math.min(Math.max(0, n - 1), hoverIdx ?? lastHoverIdxRef.current))

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel ?? `${modelName} 默认思考深度`}
      aria-disabled={disabled || undefined}
      aria-valuemin={1}
      aria-valuemax={n}
      aria-valuenow={seatedIdx + 1}
      aria-valuetext={choices[seatedIdx]?.label ?? ''}
      title={disabled ? undefined : `点击或拖动调整 ${modelName} ${ariaLabel ?? '默认思考深度'}（当前：${choices[seatedIdx]?.label ?? ''}）`}
      data-level={level}
      style={{ '--mc-tone-accent': toneAccent } as JSX.IntrinsicElements['div']['style']}
      className={`mc-ktrack${active ? ' is-live' : ''}${disabled ? ' is-disabled' : ''}${isDragging ? ' is-dragging' : ''}${isClassic ? ' is-classic' : ''}${isScenic ? ' is-scenic' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onPointerUp={(e) => finishPointer(e, true)}
      onPointerCancel={(e) => finishPointer(e, false)}
      onKeyDown={handleKeyDown}
    >
      {isClassic ? (
        <div className="mc-ktrack-pill is-classic">
          <div
            className="ef-classic-inner"
            style={{ '--ef-count': Math.max(1, n) } as JSX.IntrinsicElements['div']['style']}
          >
            <div className="ef-classic-ticks" aria-hidden="true">
              {choices.map((c, i) => (
                <span
                  key={c.value}
                  className={`ef-classic-tick${i === seatedIdx ? ' is-current' : ''}`}
                  style={{ '--ef-stop-r': stopRatio(i) } as JSX.IntrinsicElements['span']['style']}
                />
              ))}
            </div>
            <div
              className={`ef-classic-hover${showReticle ? ' is-show' : ''}`}
              style={{ '--ef-hover-r': stopRatio(hoverAnchorIdx) } as JSX.IntrinsicElements['div']['style']}
              aria-hidden="true"
            />
            <div
              className={`ef-classic-thumb${snapped ? ' is-snapped' : ''}`}
              style={{ '--ef-pos-r': stopRatio(visualFloat) } as JSX.IntrinsicElements['div']['style']}
              aria-hidden="true"
            >
              <span className="ef-classic-thumb-body" />
            </div>
            <div className="ef-classic-labels" aria-hidden="true">
              {choices.map((c, i) => (
                <span
                  key={c.value}
                  className={`ef-classic-stop${i === seatedIdx ? ' is-current' : ''}${showReticle && hoverIdx === i ? ' is-hover' : ''}`}
                  style={{ '--ef-stop-r': stopRatio(i) } as JSX.IntrinsicElements['span']['style']}
                >
                  {c.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className={`mc-ktrack-pill${isScenic ? ' is-scenic' : ''}`}>
            {isScenic ? (
              <PixelLighthouseTrackCanvas
                count={n}
                visualFloat={visualFloat}
                active={active}
                isDark={isDark}
              />
            ) : (
              <KineticTrackCanvas
                count={n}
                targetIdx={seatedIdx}
                visualFloat={visualFloat}
                active={active}
                toneKind={trackTone}
                surgeKey={surgeKey}
                isDark={isDark}
              />
            )}
          </div>

          <div
            className={`mc-ktrack-reticle${showReticle ? ' is-show' : ''}${isDark || (isScenic && active) ? ' is-on-dark' : ''}`}
            style={{ '--mc-ret-x': posCss(hoverIdx ?? seatedIdx) } as JSX.IntrinsicElements['div']['style']}
            aria-hidden="true"
          >
            {showReticle && <span className="mc-ktrack-tip">{choices[hoverIdx]?.label}</span>}
          </div>

          {!isScenic && (
            <div
              className={`mc-ktrack-emblem${isCircular ? ' is-circular' : ''}${snapped ? ' is-snapped' : ''}`}
              style={{ '--mc-em-x': posCss(visualFloat) } as JSX.IntrinsicElements['div']['style']}
              aria-hidden="true"
            >
              {isCircular ? (
                <CircularAnimatedEmblem
                  styleKind={emblemStyle}
                  toneKind={trackTone}
                  level={level}
                  active={active}
                  isDark={isDark}
                  visualFloat={visualFloat}
                  surgeKey={surgeKey}
                  sizePx={36}
                />
              ) : (
                <ClassicEffortEmblem
                  styleKind={emblemStyle}
                  toneKind={trackTone}
                  level={level}
                  active={active}
                  isDark={isDark}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ---------------- 方案三入口 A：Runtime 列头极轻弹层选单 ---------------- */

export function EffortStylePickerPopover({
  emblemStyle,
  trackTone,
  isDark,
  onSelectStyle,
  onSelectTone,
  onClose,
  closeOnSelect = false
}: {
  emblemStyle: EffortEmblemStyle
  trackTone: EffortTrackTone
  isDark: boolean
  onSelectStyle: (style: EffortEmblemStyle) => void
  onSelectTone: (tone: EffortTrackTone) => void
  onClose?: () => void
  closeOnSelect?: boolean
}): JSX.Element {
  const currentMeta = findEffortStyleOption(emblemStyle)
  const [cat, setCat] = useState<EffortStyleCategory>(currentMeta.category)
  const items = EFFORT_STYLE_CATALOG.filter((o) => o.category === cat)
  const scenicActive = isPixelLighthouseStyle(emblemStyle)

  return (
    <div className="mc-pop-card ef-popover" role="menu" aria-label="自定义思考深度滑块样式">
      <div className="mc-pop-head ef-popover-head">
        <span className="mc-pop-title">滑块外观</span>
        <div className="ef-popover-head-right">
          <span className="mc-pop-badge">{currentMeta.name}</span>
          {onClose && (
            <button
              type="button"
              className="ef-popover-close"
              aria-label="关闭滑块外观面板"
              title="关闭"
              onClick={onClose}
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="ef-cat-tabs" role="tablist" aria-label="样式分类">
        {EFFORT_STYLE_CATEGORIES.map((c) => {
          const count = EFFORT_STYLE_CATALOG.filter((o) => o.category === c.id).length
          return (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={cat === c.id}
              className={`ef-cat-tab${cat === c.id ? ' is-on' : ''}`}
              onClick={() => setCat(c.id)}
            >
              <span>{c.label}</span>
              <span className="ef-cat-cnt">{count}</span>
            </button>
          )
        })}
      </div>

      <div className={`ef-pop-grid my-scrollbar${cat === 'scenic' ? ' is-single' : ''}`}>
        {items.map((opt) => {
          const picked = opt.id === emblemStyle
          return (
            <button
              key={opt.id}
              type="button"
              role="menuitemradio"
              aria-checked={picked}
              className={`mc-emblem-opt${picked ? ' is-picked' : ''}`}
              onClick={() => {
                onSelectStyle(opt.id)
                if (closeOnSelect) onClose?.()
              }}
            >
              <span className="mc-emblem-opt-ico">
                <EffortStylePreviewBadge styleKind={opt.id} toneKind={trackTone} isDark={isDark} sizePx={24} />
              </span>
              <span className="mc-emblem-opt-meta">
                <span className="mc-emblem-opt-name">{opt.name}</span>
                <span className="mc-emblem-opt-desc">{opt.desc}</span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="mc-pop-foot ef-popover-foot">
        {scenicActive ? (
          <div className="ef-tone-note">像素灯塔自带 6 档昼夜与极光色阶，也可在「设置 → 外观」完整预览</div>
        ) : (
          <div className="mc-tone-bar" role="radiogroup" aria-label="能量色阶">
            {EFFORT_TONE_LIST.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={t.id === trackTone}
                className={`mc-tone-chip${t.id === trackTone ? ' is-on' : ''}`}
                onClick={() => onSelectTone(t.id)}
              >
                <span className="mc-tone-dot" style={{ background: t.swatch }} aria-hidden="true" />
                <span>{t.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------- 方案三入口 B：设置 → 外观 完整滑块画廊与实时预览 ---------------- */

const PREVIEW_CHOICES = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
  { value: 'max', label: '最高' },
  { value: 'extreme', label: '极限' }
] as const

export function EffortFaderPreferences(): JSX.Element {
  const effortEmblemStyle = useCollaborationPlatform((s) => s.effortEmblemStyle)
  const effortTrackTone = useCollaborationPlatform((s) => s.effortTrackTone)
  const setEffortEmblemStyle = useCollaborationPlatform((s) => s.setEffortEmblemStyle)
  const setEffortTrackTone = useCollaborationPlatform((s) => s.setEffortTrackTone)
  const isDark = useIsDarkTheme()

  const [previewIdx, setPreviewIdx] = useState(3)
  const [hoverLabel, setHoverLabel] = useState<string | null>(null)
  const [hoverPeak, setHoverPeak] = useState(false)
  const [cat, setCat] = useState<EffortStyleCategory | 'all'>(() => findEffortStyleOption(effortEmblemStyle).category)
  const [hoveredStyle, setHoveredStyle] = useState<EffortEmblemStyle | null>(null)

  const toneSpec = EFFORT_TRACK_TONES[effortTrackTone] ?? EFFORT_TRACK_TONES.obsidian
  const toneAccent = isDark ? toneSpec.accentDark : toneSpec.accentLight
  const scenicActive = isPixelLighthouseStyle(effortEmblemStyle)
  const visibleStyles = cat === 'all'
    ? EFFORT_STYLE_CATALOG
    : EFFORT_STYLE_CATALOG.filter((o) => o.category === cat)
  const readoutLabel = hoverLabel ?? PREVIEW_CHOICES[previewIdx]?.label ?? '超高'
  const readoutPeak = hoverLabel ? hoverPeak : previewIdx === PREVIEW_CHOICES.length - 1

  return (
    <PreferenceSection id="preferences-effort-fader" title="思考深度滑块">
      <PreferenceRow
        label="实时手感预览"
        hint="在模型清单调整思考深度时呈现；点击或按住 60% 磁吸拖拽体验真实动效。"
        detail={(
          <div
            className="ef-pref-preview"
            style={{ '--mc-tone-accent': toneAccent } as JSX.IntrinsicElements['div']['style']}
          >
            <div className="ef-pref-preview-bar">
              <div className="ef-pref-preview-track">
                <EffortDetentFader
                  modelName="预览模型"
                  choices={PREVIEW_CHOICES}
                  selectedIndex={previewIdx}
                  active
                  emblemStyle={effortEmblemStyle}
                  trackTone={effortTrackTone}
                  isDark={isDark}
                  onSelect={(val) => {
                    const idx = PREVIEW_CHOICES.findIndex((c) => c.value === val)
                    if (idx >= 0) setPreviewIdx(idx)
                  }}
                  onHoverPreview={(label, peak) => {
                    setHoverLabel(label)
                    setHoverPeak(peak)
                  }}
                />
              </div>
              <span className={`mc-kreadout is-active${readoutPeak ? ' is-peak' : ''}`}>
                {readoutLabel}
              </span>
            </div>
            <div className="ef-pref-tier-strip" role="group" aria-label="快捷档位预览">
              {PREVIEW_CHOICES.map((c, i) => (
                <button
                  key={c.value}
                  type="button"
                  className={`ef-pref-tier-btn${previewIdx === i ? ' is-on' : ''}`}
                  aria-pressed={previewIdx === i}
                  onClick={() => setPreviewIdx(i)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}
      >
        <span className="text-my-xs text-my-secondary">
          当前：{findEffortStyleOption(effortEmblemStyle).name}
          {!scenicActive ? ` · ${toneSpec.name}` : ' · 全境 6 档昼夜极光'}
        </span>
      </PreferenceRow>

      <PreferenceRow
        label="滑块样式"
        hint="默认提供与全站凹槽一致的「经典极简」分段滑块；另可选 12 款圆形动态仪表、1 款像素灯塔水晶球与 6 款星盘。"
        detail={(
          <div className="ef-pref-gallery">
            <div className="ef-pref-grid" role="radiogroup" aria-label="滑块样式">
              {visibleStyles.map((opt) => {
                const picked = opt.id === effortEmblemStyle
                const live = picked || hoveredStyle === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={picked}
                    className={`ef-pref-card${picked ? ' is-picked' : ''}`}
                    onMouseEnter={() => setHoveredStyle(opt.id)}
                    onMouseLeave={() => setHoveredStyle((cur) => (cur === opt.id ? null : cur))}
                    onClick={() => setEffortEmblemStyle(opt.id)}
                  >
                    <span className="ef-pref-ico">
                      <EffortStylePreviewBadge
                        styleKind={opt.id}
                        toneKind={effortTrackTone}
                        isDark={isDark}
                        sizePx={32}
                        live={live}
                      />
                    </span>
                    <span className="ef-pref-meta">
                      <span className="ef-pref-name">
                        <span>{opt.name}</span>
                        {picked && <Check size={12} aria-hidden="true" />}
                      </span>
                      <span className="ef-pref-desc">{opt.desc}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      >
        <div className="my-segmented preference-choices" role="tablist" aria-label="样式分类筛选">
          {([
            ['classic', '经典默认'],
            ['circular', '圆形机械'],
            ['scenic', '像素灯塔'],
            ['all', '全部']
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="my-segment"
              aria-selected={cat === id}
              aria-pressed={cat === id}
              onClick={() => setCat(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </PreferenceRow>

      <PreferenceRow
        label="轨道能量色阶"
        hint={scenicActive
          ? '「像素灯塔水晶球」内置 6 档昼夜极光演进；切换经典极简、圆形机械或星盘时采用下方色阶。'
          : '控制经典滑块当前档高亮、浅色柔雾深墨光丝与深色暗室雾光的主色调。'}
      >
        <div className="ef-pref-tones" role="radiogroup" aria-label="轨道能量色阶">
          {EFFORT_TONE_LIST.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={t.id === effortTrackTone}
              className={`mc-tone-chip${t.id === effortTrackTone ? ' is-on' : ''}`}
              onClick={() => setEffortTrackTone(t.id)}
            >
              <span className="mc-tone-dot" style={{ background: t.swatch }} aria-hidden="true" />
              <span>{t.name}</span>
            </button>
          ))}
        </div>
      </PreferenceRow>
    </PreferenceSection>
  )
}
