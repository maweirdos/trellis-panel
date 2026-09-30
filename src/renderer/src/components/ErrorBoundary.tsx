import { Component, type ReactNode } from 'react'

/**
 * App 级渲染崩溃兜底：任何子树抛错时显示错误卡片（含完整错误信息 + 重试/重载），
 * 不再白屏。起因：旧 preload 会话里调用今日新增的 API 时同步抛错，
 * React 整树卸载呈白屏，用户无从得知原因。
 */

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    // 崩溃细节进控制台，卡片给用户可复制摘要
    console.error('[ErrorBoundary] 渲染崩溃:', error, info?.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="grid h-full place-items-center bg-ink-900 p-8">
          <div className="w-full max-w-2xl space-y-3 rounded-xl border border-rose-500/30 bg-rose-500/5 p-5">
            <div className="text-sm font-semibold text-rose-300">界面渲染崩溃（已被拦截，未白屏）</div>
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-ink-950 p-3 font-mono text-[11px] leading-4 text-mist-300">
              {`${this.state.error.message}\n\n${this.state.error.stack ?? ''}`}
            </pre>
            <div className="flex items-center gap-2">
              <button onClick={() => this.setState({ error: null })} className="btn-outline">
                重试渲染
              </button>
              <button onClick={() => location.reload()} className="btn-primary">
                重载应用
              </button>
            </div>
            <div className="text-[10.5px] leading-4 text-mist-600">
              常见原因：dev 会话跨过了 preload/主进程改动（preload 只在应用启动时加载）——重启 <code>npm run dev</code> 即可同步。
              若重启后仍复现，请复制上方错误信息反馈。
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
