import { useEffect, useState } from 'react'
import type { EffortEmblemStyle, EffortTrackTone } from '../../crux/collaboration-platform-store'

export type EffortStyleCategory = 'circular' | 'scenic' | 'classic'

export interface EffortToneSpec {
  id: EffortTrackTone
  name: string
  swatch: string
  /** 浅色方案 A：低饱和哑光矿物薄雾 + 深墨细光丝 */
  mistRgb: string
  inkRgb: string
  /** 深色模式：暗室低饱和氛围光雾 + 纯净白光丝 */
  darkGlowRgb: string
  beamRgb: string
  streakRgb: string
  accentLight: string
  accentDark: string
  jewelTop: string
  jewelMid: string
  jewelBot: string
  idleFillLight: string
}

export interface EffortStyleOption {
  id: EffortEmblemStyle
  name: string
  desc: string
  category: EffortStyleCategory
  tag: string
}

export const EFFORT_TRACK_TONES: Readonly<Record<EffortTrackTone, EffortToneSpec>> = {
  obsidian: {
    id: 'obsidian',
    name: '曜石炭黑',
    swatch: '#1c1d22',
    mistRgb: '24, 26, 34',
    inkRgb: '18, 20, 26',
    darkGlowRgb: '216, 222, 232',
    beamRgb: '248, 250, 252',
    streakRgb: '204, 212, 224',
    accentLight: '#18181b',
    accentDark: '#e4e7ee',
    jewelTop: '#ffffff',
    jewelMid: '#8a94a6',
    jewelBot: '#22252e',
    idleFillLight: '#eaecf0'
  },
  glacier: {
    id: 'glacier',
    name: '晴空蔚蓝',
    swatch: '#2b7bf0',
    mistRgb: '48, 118, 222',
    inkRgb: '28, 76, 166',
    darkGlowRgb: '98, 174, 248',
    beamRgb: '230, 244, 255',
    streakRgb: '124, 196, 255',
    accentLight: '#1d64d6',
    accentDark: '#7ec0ff',
    jewelTop: '#e6f4ff',
    jewelMid: '#3b82f6',
    jewelBot: '#1d4ed8',
    idleFillLight: '#eaedf1'
  },
  jade: {
    id: 'jade',
    name: '清岚翠绿',
    swatch: '#1ea36b',
    mistRgb: '28, 148, 96',
    inkRgb: '16, 98, 62',
    darkGlowRgb: '88, 206, 144',
    beamRgb: '226, 252, 238',
    streakRgb: '112, 226, 164',
    accentLight: '#157d50',
    accentDark: '#6ee0a4',
    jewelTop: '#e2ffef',
    jewelMid: '#24ad70',
    jewelBot: '#0d5e3b',
    idleFillLight: '#e9eeec'
  },
  amber: {
    id: 'amber',
    name: '晨曦金橙',
    swatch: '#e28222',
    mistRgb: '214, 134, 42',
    inkRgb: '148, 72, 16',
    darkGlowRgb: '234, 170, 82',
    beamRgb: '255, 244, 220',
    streakRgb: '248, 198, 112',
    accentLight: '#c46214',
    accentDark: '#f4be66',
    jewelTop: '#fff4d6',
    jewelMid: '#e88b28',
    jewelBot: '#9a3e0e',
    idleFillLight: '#eceef0'
  }
}

export const EFFORT_TONE_LIST: ReadonlyArray<EffortToneSpec> = [
  EFFORT_TRACK_TONES.obsidian,
  EFFORT_TRACK_TONES.glacier,
  EFFORT_TRACK_TONES.jade,
  EFFORT_TRACK_TONES.amber
]

export const EFFORT_STYLE_CATALOG: ReadonlyArray<EffortStyleOption> = [
  /* 经典默认（同款 32px 胶囊凹槽刻度等宽滑块 + 6 款经典星盘） */
  { id: 'classic', name: '经典极简', desc: '凹槽刻度等宽滑块（默认）', category: 'classic', tag: '默认' },
  { id: 'crux', name: '南十字晶', desc: '双层镶嵌钻石星', category: 'classic', tag: '星盘' },
  { id: 'eclipse', name: '日食光圈', desc: '真 6 叶片机械虹膜', category: 'classic', tag: '星盘' },
  { id: 'logo', name: 'Crux 徽标', desc: '表盘倒角瓷釉章', category: 'classic', tag: '品牌' },
  { id: 'moon', name: '月相盈亏', desc: '腕表月相球面', category: 'classic', tag: '星盘' },
  { id: 'sun', name: '日轮太阳', desc: '精雕双环日晷', category: 'classic', tag: '星盘' },
  { id: 'star', name: '极简星辰', desc: '珠宝十切面星', category: 'classic', tag: '星盘' },
  /* 圆形动态机械仪表（12 款，与 32px 半圆凹槽严丝合缝） */
  { id: 'tachometer', name: '超跑转速表', desc: '指针随档冲红线弹针', category: 'circular', tag: '仪表' },
  { id: 'tourbillon', name: '机械陀飞轮', desc: '10:7 咬合双齿轮擒纵', category: 'circular', tag: '机械' },
  { id: 'turbine', name: '航空涡扇引擎', desc: '8 叶曲面扇 + 旋转涡流锥', category: 'circular', tag: '航空' },
  { id: 'radar', name: '脉冲雷达盘', desc: '余晖扫描扇面与回波点', category: 'circular', tag: '雷达' },
  { id: 'arc-reactor', name: '微型聚变堆', desc: '10 枚电磁线圈流光接力', category: 'circular', tag: '科幻' },
  { id: 'camera-lens', name: '精密相机镜组', desc: '6 片机械光圈物理开合', category: 'circular', tag: '光学' },
  { id: 'vinyl', name: '迷你黑胶唱盘', desc: '自动落针唱臂与沟槽反光', category: 'circular', tag: '复古' },
  { id: 'orrery', name: '微缩太阳系仪', desc: '三轨行星与卫星公转尾迹', category: 'circular', tag: '天文' },
  { id: 'compass', name: '惯性磁极罗盘', desc: '拖拽甩摆回正双色磁针', category: 'circular', tag: '罗盘' },
  { id: 'holo-globe', name: '旋转经纬地球仪', desc: '3D 经纬球自转与卫星环绕', category: 'circular', tag: '3D球' },
  { id: 'vault-dial', name: '精密密码转盘', desc: '切档咬合转锁与三环解锁', category: 'circular', tag: '转盘' },
  { id: 'ufo', name: '微缩星际飞碟', desc: '跑马灯舷窗与底部牵引束', category: 'circular', tag: '飞碟' },
  /* 全境互动场景（1 款：WebGL2 像素灯塔 + 3D 球面折射水晶球） */
  { id: 'pixel-lighthouse', name: '像素灯塔水晶球', desc: '色幕唤醒 + 6 档气象与极光折射', category: 'scenic', tag: '全境' }
]

export const EFFORT_STYLE_CATEGORIES: ReadonlyArray<{ id: EffortStyleCategory; label: string }> = [
  { id: 'classic', label: '经典默认' },
  { id: 'circular', label: '圆形机械' },
  { id: 'scenic', label: '像素灯塔' }
]

const CIRCULAR_STYLE_SET = new Set<EffortEmblemStyle>([
  'tachometer', 'tourbillon', 'turbine', 'radar',
  'arc-reactor', 'camera-lens', 'vinyl', 'orrery',
  'compass', 'holo-globe', 'vault-dial', 'ufo'
])

export function isClassicMinimalStyle(style: EffortEmblemStyle): boolean {
  return style === 'classic'
}

export function isCircularAnimatedStyle(style: EffortEmblemStyle): boolean {
  return CIRCULAR_STYLE_SET.has(style)
}

export function isPixelLighthouseStyle(style: EffortEmblemStyle): boolean {
  return style === 'pixel-lighthouse'
}

export function findEffortStyleOption(style: EffortEmblemStyle): EffortStyleOption {
  return EFFORT_STYLE_CATALOG.find((item) => item.id === style) ?? EFFORT_STYLE_CATALOG[0]
}

export function readDocumentDarkMode(): boolean {
  if (typeof document === 'undefined') return false
  const myRootTheme = document.querySelector('.my-root')?.getAttribute('data-my-theme')
  if (myRootTheme === 'dark') return true
  if (myRootTheme === 'light') return false
  return document.documentElement.classList.contains('dark')
    || document.documentElement.getAttribute('data-my-theme') === 'dark'
}

export function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState<boolean>(readDocumentDarkMode)

  useEffect(() => {
    const sync = (): void => setIsDark(readDocumentDarkMode())
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-my-theme'] })
    const myRoot = document.querySelector('.my-root')
    if (myRoot) {
      observer.observe(myRoot, { attributes: true, attributeFilter: ['data-my-theme', 'class'] })
    }
    return () => observer.disconnect()
  }, [])

  return isDark
}
