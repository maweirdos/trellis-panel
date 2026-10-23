import { Component, type ReactNode } from 'react'
import { CircleAlert, ChevronRight } from 'lucide-react'
import { Button } from '../my/ui'
import { StartupContentCommit } from '../daemon/StartupContext'

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
        <div className="grid h-full min-h-0 overflow-auto place-items-center bg-my-canvas p-8">
          <StartupContentCommit />
          <section role="alert" className="w-full max-w-xl space-y-4 rounded-my-xl border border-my-line bg-my-surface-1 p-5">
            <div className="flex items-center gap-2"><CircleAlert size={18} className="shrink-0 text-my-danger-text" aria-hidden="true" /><h2 className="text-my-lg font-medium text-my-primary">页面暂时无法显示</h2></div>
            <p className="text-my-sm leading-relaxed text-my-secondary">请重试当前页面；如仍无法恢复，可重载应用。</p>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => this.setState({ error: null })}>
                重试页面
              </Button>
              <Button variant="primary" onClick={() => location.reload()}>
                重载应用
              </Button>
            </div>
            <details className="group text-my-sm text-my-tertiary">
              <summary className="flex cursor-pointer list-none items-center gap-1"><ChevronRight size={12} className="transition-transform group-open:rotate-90" aria-hidden="true" />错误详情</summary>
              <pre className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded-my-md bg-my-canvas p-3 font-mono text-my-xs leading-relaxed text-my-secondary">{`${this.state.error.message}\n\n${this.state.error.stack ?? ''}`}</pre>
            </details>
          </section>
        </div>
      )
    }
    return this.props.children
  }
}
