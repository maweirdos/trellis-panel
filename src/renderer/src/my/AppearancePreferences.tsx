import type { JSX } from 'react'
import { Check } from 'lucide-react'
import { normalizeCodeFontFamily, normalizeCodeFontSize, UI_DENSITY_OPTIONS } from './appearance'
import { useMy } from './store'
import { PreferenceRow } from '../pages/settings/PreferenceSection'
import type { Settings } from '../../../shared/types'

export function ThemePreferences({ theme, disabled, onChange }: {
  theme: Settings['theme']
  disabled?: boolean
  onChange: (theme: Settings['theme']) => void
}): JSX.Element {
  return <PreferenceRow label="主题" hint="选择深色、浅色或跟随系统。">
    <div className="appearance-themes" role="group" aria-label="主题">
      {([['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']] as const).map(([value, label]) => (
        <button key={value} type="button" className="appearance-theme" aria-pressed={theme === value}
          disabled={disabled} onClick={() => onChange(value)}>
          <span className="appearance-theme-preview" aria-hidden="true">
            {(value === 'system' ? ['light', 'dark'] : [value]).map((preview) => <span key={preview} className="appearance-theme-preview-window" data-my-theme={preview}>
              <span className="appearance-theme-preview-sidebar"><i /><i /><i /></span>
              <span className="appearance-theme-preview-content"><i /><i /><i /></span>
            </span>)}
          </span>
          <span className="appearance-theme-label"><span>{label}</span>{theme === value && <Check size={14} aria-hidden="true" />}</span>
        </button>
      ))}
    </div>
  </PreferenceRow>
}

/** The density control lives in Settings; consumers use semantic tokens. */
export function AppearancePreferences(): JSX.Element {
  const fontSize = useMy((state) => state.fontSize)
  const setFontSize = useMy((state) => state.setFontSize)
  const fontFamily = useMy((state) => state.fontFamily)
  const setFontFamily = useMy((state) => state.setFontFamily)
  const codeFontFamily = useMy((state) => state.codeFontFamily)
  const setCodeFontFamily = useMy((state) => state.setCodeFontFamily)
  const codeFontSize = useMy((state) => state.codeFontSize)
  const setCodeFontSize = useMy((state) => state.setCodeFontSize)
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
    <PreferenceRow label="界面字体" htmlFor="appearance-font" hint="应用于界面和阅读内容，代码字体保持不变。">
      <select id="appearance-font" className="my-input" value={fontFamily} onChange={(event) => setFontFamily(event.target.value === 'system' ? 'system' : 'default')}>
        <option value="default">默认（思源黑体 · Inter）</option>
        <option value="system">系统字体</option>
      </select>
    </PreferenceRow>
    <PreferenceRow label="代码字体" htmlFor="appearance-code-font" hint="用于 Markdown 代码块和产物源码；未安装的字体回退到默认等宽字体。"
      detail={<pre className="appearance-code-sample my-code-content" aria-label="代码字体预览">const result = await runTask()</pre>}>
      <select id="appearance-code-font" className="my-input" value={codeFontFamily} onChange={(event) => setCodeFontFamily(normalizeCodeFontFamily(event.target.value))}>
        <option value="default">默认等宽字体</option>
        <option value="cascadia">Cascadia Mono</option>
        <option value="consolas">Consolas</option>
      </select>
    </PreferenceRow>
    <PreferenceRow label="代码字号" hint="相对界面密度调整代码块和产物源码的字号。">
      <div className="my-segmented preference-choices preference-size-choices" role="group" aria-label="代码字号">
        {([['small', '较小'], ['standard', '默认'], ['large', '较大']] as const).map(([value, label]) => (
          <button key={value} type="button" className="my-segment" aria-label={`代码字号：${label}`}
            aria-pressed={codeFontSize === value} onClick={() => setCodeFontSize(normalizeCodeFontSize(value))}>{label}</button>
        ))}
      </div>
    </PreferenceRow>
    </>
  )
}
