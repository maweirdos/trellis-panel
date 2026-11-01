import type { JSX } from 'react'
import { UI_DENSITY_OPTIONS } from './appearance'
import { useMy } from './store'
import { PreferenceRow } from '../pages/settings/PreferenceSection'

/** The density control lives in Settings; consumers use semantic tokens. */
export function AppearancePreferences(): JSX.Element {
  const fontSize = useMy((state) => state.fontSize)
  const setFontSize = useMy((state) => state.setFontSize)
  return (
    <>
    <PreferenceRow label="界面密度" hint="统一调整字号、间距和控件大小。">
      <div className="my-segmented preference-choices preference-size-choices" role="group" aria-label="界面密度">
        {UI_DENSITY_OPTIONS.map((option) => (
          <button key={option.value} type="button" className="my-segment"
            aria-label={`界面密度：${option.label}`} aria-pressed={fontSize === option.value}
            title={option.description} onClick={() => setFontSize(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
    </PreferenceRow>
    <PreferenceRow label="界面字体" hint="中文使用思源黑体，英文与数字使用 Inter。">
      <span className="text-my-md text-my-secondary">思源黑体 · Inter</span>
    </PreferenceRow>
    </>
  )
}
