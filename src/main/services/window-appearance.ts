import { nativeTheme, type BrowserWindow } from 'electron'
import type { Settings } from '../../shared/types'

// Native DWM decoration cannot consume renderer CSS variables. Mirror only the
// existing canvas / border-subtle roles from my/my-tokens.css (light and dark).
// Keep this mapping together when those semantic tokens change.
const MAIN_WINDOW_COLORS = {
  light: { backgroundColor: '#ffffff', accentColor: '#ededed' },
  dark: { backgroundColor: '#181818', accentColor: '#2a2a2a' }
} as const

interface MainWindowAppearance {
  backgroundColor: string
  accentColor?: string
}

export function mainWindowAppearance(
  theme: Settings['theme'],
  platform: NodeJS.Platform = process.platform
): MainWindowAppearance {
  const colors = MAIN_WINDOW_COLORS[theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : theme]
  return platform === 'win32' ? colors : { backgroundColor: colors.backgroundColor }
}

/** Ordinary main window only; keep transparent utility and document windows independent. */
export function applyMainWindowAppearance(
  target: Pick<BrowserWindow, 'isDestroyed' | 'setBackgroundColor' | 'setAccentColor'> | null,
  theme: Settings['theme'],
  platform: NodeJS.Platform = process.platform
): void {
  if (!target || target.isDestroyed()) return
  const appearance = mainWindowAppearance(theme, platform)
  target.setBackgroundColor(appearance.backgroundColor)
  // Electron's supported Windows accent API paints the DWM border without
  // changing native edge resizing, rounded corners, shadow or snap behavior.
  if (appearance.accentColor) target.setAccentColor(appearance.accentColor)
}
