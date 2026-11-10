import { useEffect, useLayoutEffect, useState, type JSX } from 'react'
import { X } from 'lucide-react'
import { clsx } from 'clsx'
import type { DaemonQuitApi, DaemonQuitState } from '../../../shared/daemon-quit'
import { api, hasIpc } from '../api'
import { Button, Checkbox } from '../my/ui'
import { BrandMark } from '../my/BrandMark'
import { normalizeUiFontSize, UI_PREFERENCES_KEY, type UiFontSize } from '../my/appearance'
import './quit.css'

export function DaemonQuitDialog(): JSX.Element {
  const bridge = (api as typeof api & { daemonQuit?: DaemonQuitApi })?.daemonQuit
  const [state, setState] = useState<DaemonQuitState | null>(null)
  const [keepRunning, setKeepRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 1. 同步主题与界面密度偏好
  const [windowTheme, setWindowTheme] = useState<'light' | 'dark' | 'system'>(() => {
    const value = new URLSearchParams(window.location.search).get('theme')
    return value === 'light' || value === 'system' ? value : 'dark'
  })
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [fontSize, setFontSize] = useState<UiFontSize>(() => {
    try {
      const raw = localStorage.getItem(UI_PREFERENCES_KEY)
      if (!raw) return 'standard'
      const parsed: unknown = JSON.parse(raw)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'fontSize' in parsed
        ? normalizeUiFontSize((parsed as { fontSize: unknown }).fontSize)
        : 'standard'
    } catch {
      return 'standard'
    }
  })

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (): void => setSystemDark(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!hasIpc || typeof api.onThemeChanged !== 'function') return
    return api.onThemeChanged((nextTheme) => {
      setWindowTheme(nextTheme)
    })
  }, [])

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === UI_PREFERENCES_KEY || event.key === null) {
        try {
          const raw = localStorage.getItem(UI_PREFERENCES_KEY)
          if (!raw) return
          const parsed = JSON.parse(raw) as { fontSize?: unknown }
          if (parsed?.fontSize) setFontSize(normalizeUiFontSize(parsed.fontSize))
        } catch {
          // 静默降级
        }
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const effectiveTheme = windowTheme === 'system' ? (systemDark ? 'dark' : 'light') : windowTheme

  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', effectiveTheme === 'dark')
    document.documentElement.style.colorScheme = effectiveTheme
  }, [effectiveTheme])

  // 2. 获取 Daemon 退出状态
  useEffect(() => {
    let current = true
    void bridge?.state().then(result => {
      if (!current) return
      if (result.ok) {
        setState(result.data)
        setKeepRunning(result.data.keepRunning)
        setError(result.data.error)
      } else {
        setError(result.error)
      }
    }).catch(cause => {
      if (current) setError(String(cause))
    })
    return () => { current = false }
  }, [bridge])

  const decide = async (action: 'cancel' | 'exit'): Promise<void> => {
    if (!state || !bridge || busy) return
    setBusy(true)
    try {
      const result = await bridge.decide({ attemptId: state.attemptId, action, keepRunning })
      if (!result.ok) {
        setError(result.error)
        setBusy(false)
      }
    } catch (cause) {
      setError(String(cause))
      setBusy(false)
    }
  }

  // 3. 键盘无障碍支持：Esc 取消，Enter 提交确认
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void decide('cancel')
      } else if (event.key === 'Enter') {
        const active = document.activeElement
        // 如果焦点当前处于按钮上，保持原生按钮触发逻辑
        if (active instanceof HTMLButtonElement) return
        event.preventDefault()
        void decide('exit')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state, keepRunning, busy])

  const activeJobs = state?.activeJobs ?? 0

  return (
    <div
      className="my-root daemon-quit-window"
      data-my-theme={effectiveTheme}
      data-my-font-size={fontSize}
    >
      <main className="daemon-quit-panel" aria-labelledby="quit-title">
        {/* 顶部标题栏（可拖拽移动） */}
        <header className="daemon-quit-header">
          <div className="daemon-quit-heading">
            <span className="daemon-quit-brand-icon" aria-hidden="true">
              <BrandMark className="daemon-quit-brand-svg" />
            </span>
            <h1 id="quit-title" className="daemon-quit-title">
              确定退出 Crux？
            </h1>
          </div>
          <button
            type="button"
            className="daemon-quit-close no-drag"
            title="取消 (Esc)"
            aria-label="取消退出"
            disabled={busy}
            onClick={() => void decide('cancel')}
          >
            <X size={14} />
          </button>
        </header>

        {/* 核心选项卡片与状态 */}
        <section className="daemon-quit-body">
          <div
            role="button"
            tabIndex={0}
            className={clsx(
              'daemon-quit-card no-drag',
              (!state || busy) && 'is-disabled'
            )}
            onClick={() => {
              if (state && !busy) setKeepRunning(!keepRunning)
            }}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault()
                if (state && !busy) setKeepRunning(!keepRunning)
              }
            }}
          >
            <div className="daemon-quit-card-control">
              <Checkbox checked={keepRunning} onChange={(val) => setKeepRunning(val)} />
            </div>
            <div className="daemon-quit-card-text">
              <div className="daemon-quit-card-header">
                <span className="my-item-title daemon-quit-item-name">
                  退出桌面后保留后台服务
                </span>
                {activeJobs > 0 && (
                  <span
                    className={clsx(
                      'daemon-quit-badge',
                      keepRunning ? 'daemon-quit-badge--calm' : 'daemon-quit-badge--alert'
                    )}
                  >
                    <span className="daemon-quit-badge-dot" />
                    {activeJobs} 个任务运行中
                  </span>
                )}
              </div>
              <p className="my-item-description daemon-quit-item-desc">
                {keepRunning
                  ? 'Agent 与后台集成任务将在系统托盘继续静默运行'
                  : activeJobs > 0
                    ? '退出将停止后台服务，并中断正在运行的 Agent 任务'
                    : '退出将停止后台服务及所有依赖任务'}
              </p>
            </div>
          </div>

          {error && (
            <div className="daemon-quit-error" role="alert">
              {error}
            </div>
          )}
        </section>

        {/* 底部操作栏 */}
        <footer className="daemon-quit-footer no-drag">
          <div className="daemon-quit-hint">
            <kbd className="my-kbd">Esc</kbd>
            <span>取消</span>
          </div>
          <div className="daemon-quit-buttons">
            <Button
              variant="neutral"
              disabled={!state || busy}
              onClick={() => void decide('cancel')}
            >
              取消
            </Button>
            <Button
              variant={keepRunning ? 'primary' : (activeJobs > 0 ? 'danger' : 'primary')}
              disabled={!state || busy}
              onClick={() => void decide('exit')}
            >
              {busy
                ? '正在退出…'
                : keepRunning
                  ? '退出并保留后台'
                  : '停止后台并退出'}
            </Button>
          </div>
        </footer>
      </main>
    </div>
  )
}
