import { Component, type ReactNode } from 'react'
import { FeedbackAction, FeedbackNotice } from '../my/FeedbackNotice'
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
  moduleLoadFailed: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, moduleLoadFailed: false }

  static getDerivedStateFromError(cause: unknown): State {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    return { error, moduleLoadFailed: isModuleLoadFailure(error) }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    // 崩溃细节进控制台，卡片给用户可复制摘要
    console.error('[ErrorBoundary] 渲染崩溃:', error, info?.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      const diagnostic = this.state.error.stack ?? `${this.state.error.name}: ${this.state.error.message}`
      return (
        <div className="grid h-full min-h-0 overflow-auto place-items-center bg-my-canvas p-8">
          <StartupContentCommit />
          <div className="w-full max-w-xl">
            <FeedbackNotice
              title="页面暂时无法显示"
              description={this.state.moduleLoadFailed
                ? '页面模块没有成功加载。请重载应用。'
                : '当前页面渲染中断。可重试当前内容。'}
              diagnostic={diagnostic}
              actions={<>
                {this.state.moduleLoadFailed
                  ? <FeedbackAction variant="primary" onClick={() => window.location.reload()}>重载应用</FeedbackAction>
                  : <>
                    <FeedbackAction variant="primary" onClick={() => this.setState({ error: null, moduleLoadFailed: false })}>重试页面</FeedbackAction>
                    <FeedbackAction onClick={() => window.location.reload()}>重载应用</FeedbackAction>
                  </>}
              </>}
            />
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function isModuleLoadFailure(error: Error): boolean {
  return error.name === 'PageModuleLoadError'
    || /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(error.message)
    || error instanceof SyntaxError && /does not provide an export named/i.test(error.message)
}
