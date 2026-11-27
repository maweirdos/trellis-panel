import type { EffortEmblemStyle } from '../../crux/collaboration-platform-store'
import type { EffortToneSpec } from './effort-catalog'

function drawCircularFrame(ctx: CanvasRenderingContext2D, r: number, strokeCol: string): void {
  const rimG = ctx.createLinearGradient(-r, -r, r, r)
  rimG.addColorStop(0, '#ffffff')
  rimG.addColorStop(0.55, '#dfe5ee')
  rimG.addColorStop(1, '#9ba8bc')
  ctx.fillStyle = rimG
  ctx.strokeStyle = strokeCol
  ctx.lineWidth = 0.85
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
}

/** 渲染 12 款纯圆形贴槽动态机械/仪表雕塑滑块（60fps Retina 安全） */
export function drawCircularSculpture(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  kind: EffortEmblemStyle,
  lv: number,
  isDark: boolean,
  isActive: boolean,
  tone: EffortToneSpec,
  tSec: number,
  vx: number,
  snapSpin: number
): void {
  ctx.save()
  ctx.translate(cx, cy)
  const scale = radius / 16.5
  ctx.scale(scale, scale)

  const ink = '#141418'
  const strokeCol = isDark
    ? (lv >= 3 && isActive ? tone.accentDark : 'rgba(255, 255, 255, 0.30)')
    : (lv >= 2 && isActive ? `rgba(${tone.inkRgb}, 0.82)` : 'rgba(15, 23, 42, 0.38)')
  const accent = isDark ? tone.accentDark : tone.accentLight
  const brightCol = isDark ? tone.jewelTop : accent

  ctx.shadowColor = isDark ? 'rgba(0, 0, 0, 0.55)' : 'rgba(15, 23, 42, 0.18)'
  ctx.shadowBlur = isDark ? 4 : 2.8
  ctx.shadowOffsetY = 1.0

  if (kind === 'tachometer') {
    drawCircularFrame(ctx, 13.6, strokeCol)
    ctx.save()
    ctx.shadowColor = 'transparent'
    ctx.fillStyle = '#12151c'
    ctx.beginPath()
    ctx.arc(0, 0, 11.6, 0, Math.PI * 2)
    ctx.fill()

    const startA = Math.PI * 0.78
    const totalA = Math.PI * 1.44
    const ratio = (lv + 0.35) / 5.5
    const revBounce = lv === 5 && isActive
      ? Math.sin(tSec * 34) * 0.055
      : (lv >= 3 && isActive ? Math.sin(tSec * 16) * 0.018 : 0)
    const needleA = startA + totalA * Math.min(1.02, Math.max(0.05, ratio + revBounce + vx * 0.08))

    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)'
    ctx.lineWidth = 2.0
    ctx.beginPath()
    ctx.arc(0, 0, 8.6, startA, startA + totalA)
    ctx.stroke()

    ctx.strokeStyle = 'rgba(239, 68, 68, 0.65)'
    ctx.lineWidth = 2.0
    ctx.beginPath()
    ctx.arc(0, 0, 8.6, startA + totalA * 0.8, startA + totalA)
    ctx.stroke()

    ctx.strokeStyle = lv === 5 ? '#f97316' : tone.accentDark
    ctx.lineWidth = 2.2
    ctx.beginPath()
    ctx.arc(0, 0, 8.6, startA, needleA)
    ctx.stroke()

    for (let i = 0; i <= 8; i++) {
      const a = startA + (i / 8) * totalA
      ctx.strokeStyle = i >= 7 ? '#f87171' : 'rgba(255, 255, 255, 0.68)'
      ctx.lineWidth = i % 2 === 0 ? 0.95 : 0.6
      ctx.beginPath()
      ctx.moveTo(Math.cos(a) * 6.5, Math.sin(a) * 6.5)
      ctx.lineTo(Math.cos(a) * 9.8, Math.sin(a) * 9.8)
      ctx.stroke()
    }

    const shiftOn = lv === 5 ? Math.sin(tSec * 22) > 0 : lv === 4
    ctx.fillStyle = shiftOn ? '#ef4444' : 'rgba(255, 255, 255, 0.18)'
    ctx.beginPath()
    ctx.arc(0, -5.0, shiftOn ? 1.25 : 0.9, 0, Math.PI * 2)
    ctx.fill()

    ctx.save()
    ctx.rotate(needleA)
    ctx.fillStyle = lv === 5 ? '#fb923c' : '#ffffff'
    ctx.beginPath()
    ctx.moveTo(-2.2, -0.8)
    ctx.lineTo(9.4, 0)
    ctx.lineTo(-2.2, 0.8)
    ctx.closePath()
    ctx.fill()
    ctx.restore()

    ctx.fillStyle = '#e2e8f0'
    ctx.beginPath()
    ctx.arc(0, 0, 2.3, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = lv >= 2 ? tone.jewelMid : '#334155'
    ctx.beginPath()
    ctx.arc(0, 0, 1.1, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    ctx.restore()
    return
  }

  if (kind === 'arc-reactor') {
    drawCircularFrame(ctx, 13.6, strokeCol)
    ctx.save()
    ctx.shadowColor = 'transparent'
    ctx.fillStyle = '#11141a'
    ctx.beginPath()
    ctx.arc(0, 0, 11.8, 0, Math.PI * 2)
    ctx.fill()

    const coils = 10
    const wavePos = (tSec * (2.5 + lv * 2.2)) % coils
    for (let i = 0; i < coils; i++) {
      const a = (i / coils) * Math.PI * 2 - Math.PI / 2
      let d1 = Math.abs(i - wavePos)
      d1 = Math.min(d1, coils - d1)
      let d2 = Math.abs(i - ((wavePos + 5) % coils))
      d2 = Math.min(d2, coils - d2)
      const energy = lv === 0
        ? 0.14
        : lv === 5
          ? 0.96
          : Math.max(0.22, Math.exp(-d1 * 0.95), lv >= 2 ? Math.exp(-d2 * 0.95) : 0)
      ctx.save()
      ctx.rotate(a)
      ctx.fillStyle = `rgba(${tone.streakRgb}, ${(0.22 + energy * 0.78).toFixed(2)})`
      ctx.beginPath()
      ctx.roundRect(-1.05, -10.8, 2.1, 3.3, 0.65)
      ctx.fill()
      ctx.restore()
    }

    const ringR = 5.8 + (lv === 5 ? Math.sin(tSec * 12) * 0.35 : 0)
    ctx.strokeStyle = lv >= 2 ? tone.jewelTop : `rgba(${tone.beamRgb}, 0.45)`
    ctx.lineWidth = 1.2 + lv * 0.25
    ctx.beginPath()
    ctx.arc(0, 0, ringR, 0, Math.PI * 2)
    ctx.stroke()

    if (lv >= 3) {
      ctx.save()
      ctx.rotate(-tSec * (1.2 + lv * 0.6))
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 0.85
      ctx.setLineDash([4.5, 4.5])
      ctx.beginPath()
      ctx.arc(0, 0, 3.9, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()
    }

    const coreG = ctx.createRadialGradient(0, 0, 0.4, 0, 0, 4.2)
    coreG.addColorStop(0, '#ffffff')
    coreG.addColorStop(0.5, lv >= 2 ? tone.jewelMid : '#475569')
    coreG.addColorStop(1, 'rgba(0, 0, 0, 0)')
    ctx.fillStyle = coreG
    ctx.beginPath()
    ctx.arc(0, 0, 3.6 + lv * 0.35, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    ctx.restore()
    return
  }

  if (kind === 'camera-lens') {
    drawCircularFrame(ctx, 13.6, strokeCol)
    ctx.save()
    ctx.shadowColor = 'transparent'
    ctx.fillStyle = '#181b22'
    ctx.beginPath()
    ctx.arc(0, 0, 11.8, 0, Math.PI * 2)
    ctx.fill()

    ctx.save()
    ctx.rotate(lv * 0.55 + vx * 0.8)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
    ctx.lineWidth = 0.7
    ctx.setLineDash([1.5, 2.6])
    ctx.beginPath()
    ctx.arc(0, 0, 10.6, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#ef4444'
    ctx.beginPath()
    ctx.arc(0, -10.6, 0.85, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    ctx.beginPath()
    ctx.arc(0, 0, 9.2, 0, Math.PI * 2)
    ctx.clip()
    const irisR = 2.0 + lv * 1.25 + (lv === 5 && isActive ? Math.sin(tSec * 6) * 0.35 : 0)
    const glassG = ctx.createRadialGradient(-2.5 + vx * 3, -2.5, 0.8, 0, 0, 9.5)
    glassG.addColorStop(0, lv >= 2 ? tone.jewelTop : '#cbd5e1')
    glassG.addColorStop(0.45, lv >= 2 ? tone.jewelMid : '#334155')
    glassG.addColorStop(1, '#090c12')
    ctx.fillStyle = glassG
    ctx.fillRect(-10, -10, 20, 20)

    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + lv * 0.14
      ctx.save()
      ctx.rotate(a)
      ctx.fillStyle = i % 2 === 0 ? '#232834' : '#1b202a'
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)'
      ctx.lineWidth = 0.55
      ctx.beginPath()
      ctx.moveTo(irisR, 0)
      ctx.lineTo(10.5, -5.5)
      ctx.lineTo(10.5, 5.5)
      ctx.lineTo(irisR * 0.5, irisR * 0.866)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }

    const glintX = -irisR * 0.32 + Math.sin(tSec * 1.4) * 0.4 + vx * 1.6
    const glintY = -irisR * 0.32
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)'
    ctx.beginPath()
    ctx.arc(glintX, glintY, Math.max(0.7, irisR * 0.2), 0, Math.PI * 2)
    ctx.fill()
    if (lv >= 2) {
      ctx.fillStyle = `rgba(${tone.streakRgb}, 0.55)`
      ctx.beginPath()
      ctx.arc(-glintX * 0.65, -glintY * 0.65, Math.max(0.5, irisR * 0.12), 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
    ctx.restore()
    return
  }

  if (kind === 'vinyl') {
    drawCircularFrame(ctx, 13.6, strokeCol)
    ctx.save()
    ctx.shadowColor = 'transparent'
    const spin = tSec * (lv === 0 ? 0 : 1.5 + lv * 1.45)

    ctx.fillStyle = '#14151a'
    ctx.beginPath()
    ctx.arc(0, 0, 12.0, 0, Math.PI * 2)
    ctx.fill()

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)'
    ctx.lineWidth = 0.5
    for (const gr of [6.4, 8.0, 9.6, 11.0]) {
      ctx.beginPath()
      ctx.arc(0, 0, gr, 0, Math.PI * 2)
      ctx.stroke()
    }

    ctx.save()
    ctx.rotate(spin * 0.35 + 0.6)
    for (const off of [0, Math.PI]) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.11)'
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.arc(0, 0, 11.8, off, off + 0.55)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()

    if (lv >= 4) {
      ctx.strokeStyle = `rgba(${tone.streakRgb}, 0.65)`
      ctx.lineWidth = 0.85
      ctx.beginPath()
      ctx.arc(0, 0, 8.8, spin, spin + Math.PI * 1.2)
      ctx.stroke()
    }

    ctx.save()
    ctx.rotate(spin)
    ctx.fillStyle = lv >= 1 ? tone.jewelMid : '#475569'
    ctx.beginPath()
    ctx.arc(0, 0, 4.7, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.beginPath()
    ctx.roundRect(-3.4, -0.7, 2.2, 1.4, 0.5)
    ctx.fill()
    ctx.fillStyle = '#14151a'
    ctx.beginPath()
    ctx.arc(0, 0, 1.25, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    const armAngle = lv === 0 ? -0.18 : 0.18 + lv * 0.04 + Math.sin(tSec * 8) * 0.012
    ctx.save()
    ctx.translate(9.6, -7.8)
    ctx.rotate(armAngle)
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 1.25
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(-2.6, 11.2)
    ctx.stroke()
    ctx.fillStyle = lv >= 2 ? tone.jewelTop : '#ffffff'
    ctx.beginPath()
    ctx.roundRect(-3.9, 10.2, 2.4, 3.0, 0.7)
    ctx.fill()
    ctx.fillStyle = '#94a3b8'
    ctx.beginPath()
    ctx.arc(0, 0, 2.1, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    ctx.restore()
    ctx.restore()
    return
  }

  if (kind === 'orrery') {
    drawCircularFrame(ctx, 13.6, strokeCol)
    ctx.save()
    ctx.shadowColor = 'transparent'
    const skyG = ctx.createRadialGradient(0, 0, 1, 0, 0, 12)
    skyG.addColorStop(0, '#1d2432')
    skyG.addColorStop(1, '#0c0f16')
    ctx.fillStyle = skyG
    ctx.beginPath()
    ctx.arc(0, 0, 11.8, 0, Math.PI * 2)
    ctx.fill()

    const planets = [
      { r: 4.5, spd: 2.1, size: 1.25, col: '#e2e8f0', minLv: 0, hasMoon: false },
      { r: 7.4, spd: 1.25, size: 1.75, col: tone.accentDark, minLv: 1, hasMoon: true },
      { r: 10.1, spd: 0.72, size: 1.5, col: tone.jewelTop, minLv: 2, hasMoon: false }
    ]
    const mul = 0.55 + lv * 0.48

    planets.forEach((p) => {
      if (lv < p.minLv) return
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)'
      ctx.lineWidth = 0.55
      ctx.beginPath()
      ctx.arc(0, 0, p.r, 0, Math.PI * 2)
      ctx.stroke()
    })

    const sunR = 2.1 + lv * 0.16
    if (lv >= 3) {
      const sg = ctx.createRadialGradient(0, 0, 1, 0, 0, sunR * 2.4)
      sg.addColorStop(0, `rgba(${tone.streakRgb}, 0.65)`)
      sg.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = sg
      ctx.beginPath()
      ctx.arc(0, 0, sunR * 2.4, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.fillStyle = lv >= 2 ? tone.jewelTop : '#f1f5f9'
    ctx.beginPath()
    ctx.arc(0, 0, sunR, 0, Math.PI * 2)
    ctx.fill()

    planets.forEach((p, idx) => {
      if (lv < p.minLv) return
      const a = tSec * p.spd * mul + idx * 2.1
      if (lv >= 3) {
        ctx.strokeStyle = `rgba(${tone.beamRgb}, 0.42)`
        ctx.lineWidth = 0.85
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.arc(0, 0, p.r, a - 0.65, a)
        ctx.stroke()
      }
      const px = Math.cos(a) * p.r
      const py = Math.sin(a) * p.r
      ctx.fillStyle = p.col
      ctx.beginPath()
      ctx.arc(px, py, p.size, 0, Math.PI * 2)
      ctx.fill()
      if (p.hasMoon && lv >= 2) {
        const ma = tSec * 5.2 * mul
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        ctx.arc(px + Math.cos(ma) * 2.8, py + Math.sin(ma) * 2.8, 0.65, 0, Math.PI * 2)
        ctx.fill()
      }
    })
    ctx.restore()
    ctx.restore()
    return
  }

  if (kind === 'compass') {
    drawCircularFrame(ctx, 13.6, strokeCol)
    ctx.save()
    ctx.shadowColor = 'transparent'
    ctx.fillStyle = isDark ? '#12151c' : '#f8fafc'
    ctx.beginPath()
    ctx.arc(0, 0, 11.7, 0, Math.PI * 2)
    ctx.fill()

    const ringRot = lv >= 3 ? tSec * (0.25 + (lv - 2) * 0.25) : 0
    ctx.save()
    ctx.rotate(ringRot)
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2
      const cardinal = i % 4 === 0
      ctx.strokeStyle = cardinal ? accent : (isDark ? 'rgba(255, 255, 255, 0.28)' : 'rgba(15, 23, 42, 0.25)')
      ctx.lineWidth = cardinal ? 1.15 : 0.6
      ctx.beginPath()
      ctx.moveTo(Math.cos(a) * (cardinal ? 7.8 : 9.2), Math.sin(a) * (cardinal ? 7.8 : 9.2))
      ctx.lineTo(Math.cos(a) * 11.0, Math.sin(a) * 11.0)
      ctx.stroke()
    }
    ctx.restore()

    const wobble = Math.sin(tSec * (2.2 + lv * 1.4)) * (0.08 + lv * 0.03)
      + Math.sin(tSec * (5.5 + lv * 2.2)) * (lv >= 4 ? 0.07 : 0.01)
      + vx * 1.15
    const targetHeading = -Math.PI / 2 + (lv / 5) * 0.95 + wobble
    ctx.save()
    ctx.rotate(targetHeading)
    ctx.fillStyle = lv === 5 ? '#ef4444' : accent
    ctx.beginPath()
    ctx.moveTo(8.8, 0)
    ctx.lineTo(0, -2.1)
    ctx.lineTo(0, 2.1)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = isDark ? '#64748b' : '#94a3b8'
    ctx.beginPath()
    ctx.moveTo(-8.2, 0)
    ctx.lineTo(0, -2.1)
    ctx.lineTo(0, 2.1)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = ink
    ctx.lineWidth = 0.7
    ctx.beginPath()
    ctx.arc(0, 0, 1.85, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
    ctx.restore()
    ctx.restore()
    return
  }

  if (kind === 'holo-globe') {
    drawCircularFrame(ctx, 13.6, strokeCol)
    ctx.save()
    ctx.shadowColor = 'transparent'
    const r = 11.4
    const bg = ctx.createRadialGradient(-3, -3, 1, 0, 0, r)
    bg.addColorStop(0, lv >= 2 ? '#1e3040' : '#232834')
    bg.addColorStop(1, '#0c1018')
    ctx.fillStyle = bg
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.fill()

    const satA = tSec * (1.8 + lv * 0.6)
    const satX = Math.cos(satA) * 12.8
    const satY = Math.sin(satA) * 4.4
    const satFront = Math.sin(satA) >= 0

    ctx.save()
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.clip()
    const spin = tSec * (0.45 + lv * 0.45)
    const lineCol = lv >= 2 ? `rgba(${tone.streakRgb}, 0.55)` : 'rgba(226, 232, 240, 0.34)'

    ctx.strokeStyle = lineCol
    for (const ly of [-5.2, 0, 5.2]) {
      ctx.lineWidth = ly === 0 ? 0.95 : 0.55
      ctx.beginPath()
      ctx.moveTo(-r, ly)
      ctx.lineTo(r, ly)
      ctx.stroke()
    }
    for (let i = 0; i < 6; i++) {
      const a = (spin + (i / 6) * Math.PI) % Math.PI
      const rx = Math.abs(Math.cos(a)) * r
      ctx.strokeStyle = a < 0.25 || a > Math.PI - 0.25 ? tone.jewelTop : lineCol
      ctx.lineWidth = 0.7
      ctx.beginPath()
      ctx.ellipse(0, 0, Math.max(0.4, rx), r, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
    if (lv === 5 && isActive) {
      const scanY = Math.sin(tSec * 3.8) * r * 0.82
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.25
      ctx.beginPath()
      ctx.moveTo(-r, scanY)
      ctx.lineTo(r, scanY)
      ctx.stroke()
    }
    ctx.restore()

    if (lv >= 2) {
      ctx.save()
      ctx.rotate(-0.42)
      ctx.strokeStyle = `rgba(${tone.beamRgb}, 0.35)`
      ctx.lineWidth = 0.65
      ctx.beginPath()
      ctx.ellipse(0, 0, 12.8, 4.4, 0, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillStyle = satFront ? tone.jewelTop : `rgba(${tone.beamRgb}, 0.45)`
      ctx.beginPath()
      ctx.arc(satX, satY, satFront ? 1.5 : 1.0, 0, Math.PI * 2)
      ctx.fill()
      if (lv >= 3) {
        const sat2A = -satA * 1.25 + 1.8
        ctx.fillStyle = accent
        ctx.beginPath()
        ctx.arc(Math.cos(sat2A) * 12.8, Math.sin(sat2A) * 4.4, 1.2, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }
    ctx.restore()
    ctx.restore()
    return
  }

  if (kind === 'vault-dial') {
    const spinEase = snapSpin > 0 ? 1 - Math.pow(1 - snapSpin, 3) : 0
    const dialAngle = lv * 0.75 + spinEase * Math.PI * 0.67 + (lv >= 4 ? Math.sin(tSec * 4) * 0.06 : 0)

    drawCircularFrame(ctx, 13.6, strokeCol)
    ctx.save()
    ctx.shadowColor = 'transparent'
    ctx.fillStyle = '#181c24'
    ctx.beginPath()
    ctx.arc(0, 0, 11.7, 0, Math.PI * 2)
    ctx.fill()

    ctx.save()
    ctx.rotate(dialAngle)
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      ctx.strokeStyle = i === 0 ? tone.jewelTop : 'rgba(255, 255, 255, 0.45)'
      ctx.lineWidth = i % 3 === 0 ? 1.1 : 0.6
      ctx.beginPath()
      ctx.moveTo(Math.cos(a) * 8.4, Math.sin(a) * 8.4)
      ctx.lineTo(Math.cos(a) * 11.0, Math.sin(a) * 11.0)
      ctx.stroke()
    }
    ctx.restore()

    const innerAngle = lv >= 4 ? 0 : -dialAngle * 1.3 + (5 - lv) * 0.45
    ctx.save()
    ctx.rotate(innerAngle)
    ctx.strokeStyle = lv >= 4 ? tone.accentDark : 'rgba(255, 255, 255, 0.34)'
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.arc(0, 0, 6.8, -Math.PI * 0.38, Math.PI * 1.38)
    ctx.stroke()
    ctx.restore()

    ctx.save()
    ctx.rotate(dialAngle * 0.5)
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 1.6
    ctx.lineCap = 'round'
    for (let k = 0; k < 3; k++) {
      const ka = (k * Math.PI * 2) / 3 - Math.PI / 2
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(Math.cos(ka) * 5.2, Math.sin(ka) * 5.2)
      ctx.stroke()
    }
    ctx.restore()

    ctx.fillStyle = ink
    ctx.beginPath()
    ctx.arc(0, 0, 2.7, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = lv >= 4 ? (lv === 5 ? tone.jewelTop : tone.accentDark) : (lv >= 2 ? tone.jewelMid : '#64748b')
    ctx.beginPath()
    ctx.arc(0, 0, 1.65, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = lv >= 4 ? tone.accentDark : '#ef4444'
    ctx.beginPath()
    ctx.moveTo(0, -10.8)
    ctx.lineTo(-1.7, -13.6)
    ctx.lineTo(1.7, -13.6)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
    ctx.restore()
    return
  }

  if (kind === 'tourbillon') {
    const drawGear = (gx: number, gy: number, rO: number, rI: number, teeth: number, rot: number, fill: string | CanvasGradient, st: string): void => {
      ctx.save()
      ctx.translate(gx, gy)
      ctx.rotate(rot)
      ctx.beginPath()
      const step = (Math.PI * 2) / teeth
      for (let i = 0; i < teeth; i++) {
        const a = i * step
        ctx.lineTo(Math.cos(a) * rI, Math.sin(a) * rI)
        ctx.lineTo(Math.cos(a + step * 0.18) * rO, Math.sin(a + step * 0.18) * rO)
        ctx.lineTo(Math.cos(a + step * 0.52) * rO, Math.sin(a + step * 0.52) * rO)
        ctx.lineTo(Math.cos(a + step * 0.7) * rI, Math.sin(a + step * 0.7) * rI)
      }
      ctx.closePath()
      ctx.fillStyle = fill
      ctx.strokeStyle = st
      ctx.lineWidth = 0.65
      ctx.fill()
      ctx.stroke()
      ctx.shadowColor = 'transparent'
      ctx.fillStyle = isDark ? '#14151a' : '#e6eaf0'
      for (let k = 0; k < 4; k++) {
        const ka = (k * Math.PI) / 2
        ctx.beginPath()
        ctx.arc(Math.cos(ka) * (rI * 0.54), Math.sin(ka) * (rI * 0.54), rI * 0.19, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }
    let ang1 = 0
    if (lv <= 1) {
      const hz = lv === 0 ? 1.2 : 2.6
      const u = tSec * hz
      const fl = Math.floor(u)
      const frac = u - fl
      ang1 = (fl + (1 - Math.pow(1 - Math.min(1, frac * 2.4), 3))) * ((Math.PI * 2) / 10)
    } else {
      ang1 = tSec * (0.75 + lv * 0.9)
    }
    const ang2 = -ang1 * (10 / 7) + 0.32
    ctx.save()
    ctx.shadowColor = 'transparent'
    ctx.strokeStyle = lv >= 3 ? accent : strokeCol
    ctx.lineWidth = 0.85
    ctx.setLineDash(lv >= 4 ? [10, 4] : [3, 3])
    ctx.beginPath()
    ctx.arc(0, 0, 13.6, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()

    drawGear(6.8, -5.6, 5.0, 3.5, 7, ang2, lv >= 2 ? tone.jewelTop : '#d7dfe9', strokeCol)
    const gFill = ctx.createLinearGradient(-9, -9, 9, 9)
    gFill.addColorStop(0, '#ffffff')
    gFill.addColorStop(0.6, '#e6ecf3')
    gFill.addColorStop(1, '#bcc7d6')
    drawGear(-1.5, 1.1, 9.8, 7.6, 10, ang1, gFill, strokeCol)
    ctx.save()
    ctx.shadowColor = 'transparent'
    ctx.fillStyle = ink
    ctx.beginPath()
    ctx.arc(-1.5, 1.1, 2.9, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = tone.jewelMid
    ctx.beginPath()
    ctx.arc(-1.5, 1.1, 1.95, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    ctx.restore()
    return
  }

  if (kind === 'turbine') {
    const spin = tSec * (0.9 + Math.pow(lv, 1.75) * 1.45)
    drawCircularFrame(ctx, 13.6, strokeCol)
    ctx.save()
    ctx.shadowColor = 'transparent'
    ctx.beginPath()
    ctx.arc(0, 0, 11.2, 0, Math.PI * 2)
    ctx.clip()
    const coreBg = ctx.createRadialGradient(0, 0, 2, 0, 0, 11.5)
    coreBg.addColorStop(0, lv >= 2 ? (lv >= 4 ? tone.jewelTop : tone.jewelMid) : '#272c36')
    coreBg.addColorStop(1, '#101218')
    ctx.fillStyle = coreBg
    ctx.fillRect(-12, -12, 24, 24)
    for (let i = 0; i < 8; i++) {
      ctx.save()
      ctx.rotate(spin + (i / 8) * Math.PI * 2)
      const bG = ctx.createLinearGradient(0, -11, 3, -3)
      bG.addColorStop(0, '#eef3f9')
      bG.addColorStop(0.55, '#96a3b5')
      bG.addColorStop(1, '#475263')
      ctx.fillStyle = bG
      ctx.beginPath()
      ctx.moveTo(0, -3.0)
      ctx.quadraticCurveTo(3.4, -6.5, 2.2, -11.0)
      ctx.lineTo(-1.4, -11.0)
      ctx.quadraticCurveTo(-0.2, -6.5, -1.6, -3.0)
      ctx.closePath()
      ctx.fill()
      ctx.restore()
    }
    ctx.save()
    ctx.rotate(spin)
    ctx.fillStyle = '#14161c'
    ctx.beginPath()
    ctx.arc(0, 0, 4.1, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = lv >= 4 ? tone.jewelTop : '#ffffff'
    ctx.lineWidth = 1.25
    ctx.lineCap = 'round'
    ctx.beginPath()
    for (let s = 0; s <= 18; s++) {
      const t = s / 18
      const sa = t * Math.PI * 2.2
      const sr = t * 3.4
      if (s === 0) ctx.moveTo(Math.cos(sa) * sr, Math.sin(sa) * sr)
      else ctx.lineTo(Math.cos(sa) * sr, Math.sin(sa) * sr)
    }
    ctx.stroke()
    ctx.restore()
    ctx.restore()
    ctx.restore()
    return
  }

  if (kind === 'radar') {
    drawCircularFrame(ctx, 13.6, strokeCol)
    ctx.save()
    ctx.shadowColor = 'transparent'
    ctx.beginPath()
    ctx.arc(0, 0, 11.4, 0, Math.PI * 2)
    ctx.clip()
    ctx.fillStyle = '#0f1419'
    ctx.fillRect(-12, -12, 24, 24)
    ctx.strokeStyle = `rgba(${tone.streakRgb}, 0.24)`
    ctx.lineWidth = 0.6
    ctx.beginPath()
    ctx.arc(0, 0, 4.2, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(0, 0, 8.0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(-12, 0)
    ctx.lineTo(12, 0)
    ctx.moveTo(0, -12)
    ctx.lineTo(0, 12)
    ctx.stroke()

    const sweepA = (tSec * (1.1 + lv * 1.15)) % (Math.PI * 2)
    const drawSweep = (base: number): void => {
      for (let i = 0; i < 10; i++) {
        const a0 = base - ((i + 1) / 10) * 1.15
        const a1 = base - (i / 10) * 1.15
        ctx.fillStyle = `rgba(${tone.streakRgb}, ${(Math.pow(1 - i / 10, 1.8) * (0.28 + lv * 0.05)).toFixed(3)})`
        ctx.beginPath()
        ctx.moveTo(0, 0)
        ctx.arc(0, 0, 11.4, a0, a1)
        ctx.closePath()
        ctx.fill()
      }
      ctx.strokeStyle = tone.jewelTop
      ctx.lineWidth = 1.15
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(Math.cos(base) * 11.2, Math.sin(base) * 11.2)
      ctx.stroke()
    }
    drawSweep(sweepA)
    if (lv === 5) drawSweep((sweepA + Math.PI) % (Math.PI * 2))

    const blips = [
      { r: 6.4, a: 0.7 },
      { r: 4.5, a: 2.35 },
      { r: 8.4, a: 3.9 },
      { r: 5.8, a: 5.25 }
    ]
    for (let i = 0; i < Math.min(4, 1 + lv); i++) {
      const b = blips[i]
      let diff = (sweepA - b.a) % (Math.PI * 2)
      if (diff < 0) diff += Math.PI * 2
      const g = Math.max(0.16, Math.exp(-diff * 1.15))
      ctx.fillStyle = `rgba(${tone.beamRgb}, ${g.toFixed(2)})`
      ctx.beginPath()
      ctx.arc(Math.cos(b.a) * b.r, Math.sin(b.a) * b.r, 1.05 + g * 0.7, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(0, 0, 1.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    ctx.restore()
    return
  }

  /* ufo */
  const hoverY = Math.sin(tSec * (2.2 + lv * 0.8)) * 0.7 - (lv >= 3 ? 1.2 : 0)
  ctx.translate(0, hoverY)
  ctx.rotate(Math.sin(tSec * 1.6) * 0.08 + vx * 0.18)
  if (lv >= 3 && isActive) {
    ctx.save()
    ctx.shadowColor = 'transparent'
    const bh = 6 + (lv - 2) * 2
    const bg = ctx.createLinearGradient(0, 3, 0, 3 + bh)
    bg.addColorStop(0, isDark ? `rgba(${tone.streakRgb}, 0.55)` : `rgba(${tone.mistRgb}, 0.40)`)
    bg.addColorStop(1, 'rgba(255, 255, 255, 0)')
    ctx.fillStyle = bg
    ctx.beginPath()
    ctx.moveTo(-4, 3)
    ctx.lineTo(-7.2, 3 + bh)
    ctx.lineTo(7.2, 3 + bh)
    ctx.lineTo(4, 3)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
  const discG = ctx.createLinearGradient(-13, -3, 13, 5)
  discG.addColorStop(0, '#ffffff')
  discG.addColorStop(0.55, '#e8edf5')
  discG.addColorStop(1, '#b6c2d4')
  ctx.fillStyle = discG
  ctx.strokeStyle = strokeCol
  ctx.lineWidth = 0.85
  ctx.beginPath()
  ctx.ellipse(0, 1.0, 13.4, 4.6, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  const domeG = ctx.createRadialGradient(-2, -5, 0.8, 0, -2, 7.2)
  domeG.addColorStop(0, '#ffffff')
  domeG.addColorStop(0.45, lv >= 2 ? tone.jewelTop : '#e2e8f0')
  domeG.addColorStop(1, lv >= 2 ? tone.jewelMid : '#64748b')
  ctx.fillStyle = domeG
  ctx.beginPath()
  ctx.arc(0, -0.2, 6.6, Math.PI, 0)
  ctx.quadraticCurveTo(0, 2.2, -6.6, -0.2)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  ctx.save()
  ctx.shadowColor = 'transparent'
  const ci = Math.floor(tSec * (2.2 + lv * 2.2)) % 5
  for (let i = 0; i < 5; i++) {
    const u = (i - 2) / 2
    const lx = u * 9.5
    const ly = 1.4 + (1 - u * u) * 1.4
    const lit = i === ci || (lv >= 4 && i === (ci + 2) % 5) || lv === 5
    ctx.fillStyle = lit ? brightCol : 'rgba(20, 23, 32, 0.42)'
    ctx.beginPath()
    ctx.arc(lx, ly, lit ? 1.3 : 0.9, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
  ctx.restore()
}
