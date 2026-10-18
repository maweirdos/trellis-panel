import type { JSX } from 'react'
import { UI_FONT_SIZE_OPTIONS } from './appearance'
import { useMy } from './store'
import { Button } from './ui'

/** The only font-size control lives in Settings; consumers use semantic tokens. */
export function AppearancePreferences(): JSX.Element {
  const fontSize = useMy((state) => state.fontSize)
  const setFontSize = useMy((state) => state.setFontSize)
  return (
    <fieldset className="mb-4 min-w-0 border-0 p-0" aria-label="界面字号">
      <legend className="mb-2 text-my-md font-medium text-my-primary">界面字号</legend>
      <div className="flex flex-wrap gap-2">
        {UI_FONT_SIZE_OPTIONS.map((option) => (
          <Button key={option.value} variant={fontSize === option.value ? 'primary' : 'neutral'}
            aria-label={`字号：${option.label}`} aria-pressed={fontSize === option.value}
            title={option.description} onClick={() => setFontSize(option.value)}>
            {option.label}{option.value === 'small' ? '（默认）' : ''}
          </Button>
        ))}
      </div>
      <p className="mt-2 text-my-sm leading-relaxed text-my-secondary">应用于界面、会话和文档阅读。更改后立即生效，并记住你的选择。</p>
    </fieldset>
  )
}
