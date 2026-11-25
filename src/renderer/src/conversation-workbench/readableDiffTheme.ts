import { getResolvedOrResolveTheme, registerCustomTheme } from '@pierre/diffs'

export const READABLE_DIFF_THEME = 'crux-t3-light'

const DARKER_SYNTAX_COLORS = new Set(['#1ca1c7', '#636363', '#1a85d4'])
const DELETED_LINE_LUMINANCE = 0.69

function channelLuminance(channel: number): number {
  const value = channel / 255
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function contrastOnLightCode(channels: readonly number[]): number {
  const [red, green, blue] = channels.map(channelLuminance)
  return (DELETED_LINE_LUMINANCE + 0.05) / (0.2126 * red + 0.7152 * green + 0.0722 * blue + 0.05)
}

function readableSyntaxColor(color: string): string {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color)
  if (!match) return color
  const rgbHex = match[1]
  const minContrast = DARKER_SYNTAX_COLORS.has(color.toLowerCase()) ? 6 : 4.5
  let channels = [0, 2, 4].map(offset => Number.parseInt(rgbHex.slice(offset, offset + 2), 16))
  if (contrastOnLightCode(channels) >= minContrast) return color
  while (contrastOnLightCode(channels) < minContrast) {
    channels = channels.map(channel => Math.floor(channel * 0.96))
  }
  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}${match[2] ?? ''}`
}

registerCustomTheme(READABLE_DIFF_THEME, async () => {
  const { textmate } = await getResolvedOrResolveTheme('pierre-light', 'shiki-js')
  if (!textmate) throw new Error('Pierre Light requires a TextMate theme for Shiki')
  return {
    ...textmate,
    name: READABLE_DIFF_THEME,
    settings: textmate.settings.map(rule => {
      const { foreground } = rule.settings
      return foreground ? { ...rule, settings: { ...rule.settings, foreground: readableSyntaxColor(foreground) } } : rule
    }),
  }
})
