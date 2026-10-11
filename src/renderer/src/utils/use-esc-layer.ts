import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { activateEscLayer, type EscLayerKind } from './esc-layer'

/**
 * useEscLayer（S0 G2 第三片）：组件级 Esc 层登记的 React 封装。
 *
 * - active=true 时登记一层；卸载/失活自动注销（注销函数幂等，StrictMode 双安全）。
 * - onClose 经 ref 透传最新闭包，登记不随回调身份变化重挂。
 * - returnFocusRef：关闭后归还焦点的触发元素 ref（调用方在触发处写入
 *   ref.current，如 diff 打开按钮 onClick；派发时刻读取，已卸载时安全跳过）。
 *   ref 对象须保持稳定（React useRef 天然满足），故不入 effect 依赖。
 */
export interface UseEscLayerInput {
  kind: EscLayerKind
  /** 层 ID（同 ID 重复登记互相覆盖——一个组件一个稳定 ID）。 */
  id: string
  onClose: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
  /** 焦点在输入控件内时 Esc 交给字段自身，不消费不注销层（见 esc-layer.ts）。 */
  deferWhenInputFocused?: boolean
}

export function useEscLayer(active: boolean, input: UseEscLayerInput): void {
  const { kind, id, onClose, returnFocusRef, deferWhenInputFocused } = input
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // 稳定代理：登记的层始终读 holderRef；派发时刻从调用方 ref 中转最新目标
  const holderRef = useRef<HTMLElement | null>(null)
  const latestTargetRef = useRef<RefObject<HTMLElement | null> | null>(returnFocusRef ?? null)
  latestTargetRef.current = returnFocusRef ?? null

  useEffect(() => {
    if (!active) return
    // 派发时经 holder 中转读取调用方的 ref（保持单一稳定对象注册）
    const sync = (): void => {
      holderRef.current = latestTargetRef.current?.current ?? null
    }
    sync()
    return activateEscLayer({
      id,
      kind,
      deferWhenInputFocused,
      onClose: () => {
        sync()
        onCloseRef.current()
      },
      returnFocusRef: holderRef
    })
  }, [active, id, kind])
}
