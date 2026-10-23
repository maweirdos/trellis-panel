import type { CSSProperties, JSX } from 'react'
import { clsx } from 'clsx'
import { getToolBrand, type ToolBrandId } from '@shared/tool-brands'
import './tool-brand-icon.css'
import brand0 from '../assets/tool-brands/codex.svg'
import brand1 from '../assets/tool-brands/claude-code.svg'
import brand2 from '../assets/tool-brands/cursor.svg'
import brand3 from '../assets/tool-brands/windsurf.svg'
import brand4 from '../assets/tool-brands/github-copilot.svg'
import brand5 from '../assets/tool-brands/gemini-cli.svg'
import brand6 from '../assets/tool-brands/opencode.svg'
import brand7 from '../assets/tool-brands/qoder.svg'
import brand8 from '../assets/tool-brands/kiro.svg'
import brand9 from '../assets/tool-brands/codebuddy.svg'
import brand10 from '../assets/tool-brands/trae.svg'
import brand11 from '../assets/tool-brands/cline.svg'
import brand12 from '../assets/tool-brands/roo-code.svg'
import brand13 from '../assets/tool-brands/kilo-code.svg'
import brand14 from '../assets/tool-brands/amp.svg'
import brand15 from '../assets/tool-brands/antigravity.svg'
import brand16 from '../assets/tool-brands/openhands.svg'
import brand17 from '../assets/tool-brands/goose.svg'
import brand18 from '../assets/tool-brands/replit.svg'
import brand19 from '../assets/tool-brands/devin.svg'
import brand20 from '../assets/tool-brands/vscode.svg'
import brand21 from '../assets/tool-brands/vscodium.svg'
import brand22 from '../assets/tool-brands/visual-studio.svg'
import brand23 from '../assets/tool-brands/jetbrains.svg'
import brand24 from '../assets/tool-brands/intellij-idea.svg'
import brand25 from '../assets/tool-brands/webstorm.svg'
import brand26 from '../assets/tool-brands/pycharm.svg'
import brand27 from '../assets/tool-brands/neovim.svg'
import brand28 from '../assets/tool-brands/vim.svg'
import brand29 from '../assets/tool-brands/emacs.svg'
import brand30 from '../assets/tool-brands/android-studio.svg'
import brand31 from '../assets/tool-brands/eclipse.svg'
import brand32 from '../assets/tool-brands/xcode.svg'
import brand33 from '../assets/tool-brands/rider.svg'
import brand34 from '../assets/tool-brands/goland.svg'
import brand35 from '../assets/tool-brands/phpstorm.svg'
import brand36 from '../assets/tool-brands/clion.svg'
import brand37 from '../assets/tool-brands/rubymine.svg'
import brand38 from '../assets/tool-brands/zed.svg'
import brand39 from '../assets/tool-brands/sublime-text.svg'
import brand40 from '../assets/tool-brands/zcode.png'
import brand41 from '../assets/tool-brands/aider.png'
import brand42 from '../assets/tool-brands/continue.svg'
import brand43 from '../assets/tool-brands/kimi-code.png'
import brand44 from '../assets/tool-brands/qwen-code.svg'
import brand45 from '../assets/tool-brands/pi.svg'
import brand46 from '../assets/tool-brands/factory-droid.svg'
import brand47 from '../assets/tool-brands/augment.png'
import brand48 from '../assets/tool-brands/iflow.png'

const TOOL_BRAND_ASSETS: Record<ToolBrandId, string> = {
  'codex': brand0,
  'claude-code': brand1,
  'cursor': brand2,
  'windsurf': brand3,
  'github-copilot': brand4,
  'gemini-cli': brand5,
  'opencode': brand6,
  'qoder': brand7,
  'kiro': brand8,
  'codebuddy': brand9,
  'trae': brand10,
  'cline': brand11,
  'roo-code': brand12,
  'kilo-code': brand13,
  'amp': brand14,
  'antigravity': brand15,
  'openhands': brand16,
  'goose': brand17,
  'replit': brand18,
  'devin': brand19,
  'vscode': brand20,
  'vscodium': brand21,
  'visual-studio': brand22,
  'jetbrains': brand23,
  'intellij-idea': brand24,
  'webstorm': brand25,
  'pycharm': brand26,
  'neovim': brand27,
  'vim': brand28,
  'emacs': brand29,
  'android-studio': brand30,
  'eclipse': brand31,
  'xcode': brand32,
  'rider': brand33,
  'goland': brand34,
  'phpstorm': brand35,
  'clion': brand36,
  'rubymine': brand37,
  'zed': brand38,
  'sublime-text': brand39,
  'zcode': brand40,
  'aider': brand41,
  'continue': brand42,
  'kimi-code': brand43,
  'qwen-code': brand44,
  'pi': brand45,
  'factory-droid': brand46,
  'augment': brand47,
  'iflow': brand48,
}

export interface ToolBrandIconProps {
  brand: string | undefined
  size?: number
  className?: string
}

/** Decorative, offline product identity; the adjacent UI owns the accessible name. */
export function ToolBrandIcon({ brand, size = 16, className }: ToolBrandIconProps): JSX.Element {
  const definition = getToolBrand(brand)
  const asset = definition ? TOOL_BRAND_ASSETS[definition.id] : undefined
  const mode = definition?.mode ?? 'neutral'
  const style: CSSProperties = { width: size, height: size }

  return (
    <span aria-hidden="true" className={clsx('tool-brand-icon', className)} style={style}
      data-tool-brand={definition?.id ?? 'unknown'} data-tool-brand-mode={mode}>
      {asset && mode === 'mask' ? (
        <span className="tool-brand-icon__mask"
          style={{ maskImage: `url("${asset}")`, WebkitMaskImage: `url("${asset}")` }} />
      ) : asset ? (
        <img className="tool-brand-icon__image" src={asset} alt="" draggable={false} />
      ) : (
        <svg className="tool-brand-icon__neutral" viewBox="0 0 16 16" fill="none" focusable="false">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.25" />
          <circle cx="8" cy="8" r="1.25" fill="currentColor" />
        </svg>
      )}
    </span>
  )
}
