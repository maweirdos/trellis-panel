import type { JSX } from 'react'
import { UI_FONT_SIZE_OPTIONS } from './appearance'
import { useMy } from './store'
import { PreferenceRow } from '../pages/settings/PreferenceSection'

/** The only font-size control lives in Settings; consumers use semantic tokens. */
export function AppearancePreferences(): JSX.Element {
  const fontSize = useMy((state) => state.fontSize)
  const setFontSize = useMy((state) => state.setFontSize)
  return (
    <PreferenceRow label="界面字号">
      <div className="my-segmented preference-choices" role="group" aria-label="界面字号">
        {UI_FONT_SIZE_OPTIONS.map((option) => (
          <button key={option.value} type="button" className="my-segment"
            aria-label={`字号：${option.label}`} aria-pressed={fontSize === option.value}
            title={option.description} onClick={() => setFontSize(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
    </PreferenceRow>
  )
}
