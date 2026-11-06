import { Component, createRef, type ReactNode } from 'react'
import { Button } from '../my/ui'

export class PdfPreviewBoundary extends Component<{ children: ReactNode; onClose: () => void; onOpen: () => void; shouldFocus: () => boolean; label?: string }, { failed: boolean }> {
  state = { failed: false }
  private readonly message = createRef<HTMLSpanElement>()

  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }

  componentDidCatch(): void {
    if (this.props.shouldFocus()) this.message.current?.focus()
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return <div role="alert" className="flex flex-wrap items-center gap-2 text-my-sm text-my-danger-text">
      <span ref={this.message} tabIndex={-1}>{this.props.label ?? 'PDF'} 预览组件无法加载，本次运行中重新打开可能仍然失败。请使用系统打开，或保存当前工作后重新启动应用再试。</span><Button size="sm" variant="ghost" onClick={this.props.onOpen}>系统打开</Button><Button size="sm" variant="ghost" onClick={this.props.onClose}>关闭</Button>
    </div>
  }
}
