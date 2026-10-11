/**
 * 全局 Esc 层级协调器（S0 G2 第三片，design §6.3"统一 Esc 层级"）。
 *
 * 盘点（接入前的 window 级监听"叠罗汉"问题）：
 *   - Dialogs.tsx（模态）、CommandPalette.tsx（命令面板）
 *   - ArtifactViewer.tsx（产物查看器）、Tasks.tsx（任务工作台）、TaskDetail.tsx（快速预览）
 *   同一次 Esc 会同时命中多个 window 监听（例如查看器+预览一次全关）。
 *
 * 聚合后：每个可 Esc 关闭的层调用 activateEscLayer 登记，App 顶层的唯一 window
 * 监听按优先级只消费最上层一层；关闭后焦点归还触发处（layer.returnFocusTo
 * 仍挂载时；已卸载则安全跳过）。输入框内联 Esc（字段编辑等组件级行为）不登记、
 * 不受影响。
 *
 * 层级（高 → 低）：模态/菜单 → 弹层（查看器 / 对比面板）→ 快速预览（详情抽屉 /
 * 任务工作台）。「专注」层（design §6.3）尚未存在，保留 priority 档位不在本片启用。
 */

export type EscLayerKind = 'modal' | 'overlay' | 'preview'

const PRIORITY: Record<EscLayerKind, number> = {
  modal: 40,
  overlay: 30,
  preview: 10
}

export interface EscLayer {
  id: string
  kind: EscLayerKind
  onClose: () => void
  /** 关闭后归还焦点的触发元素（派发时刻读取 .current；已卸载/脱离文档时安全跳过）。 */
  returnFocusRef?: { current: HTMLElement | null }
  /**
   * 焦点在 input/textarea/select 内时本次 Esc 交给字段自身（取消编辑等），
   * 不消费、不注销层。恢复旧 window 监听"源头检查 tagName"的语义；
   * 未声明该标志的层（Dialogs/CommandPalette 等）不受输入焦点影响。
   */
  deferWhenInputFocused?: boolean
}

interface RegisteredLayer extends EscLayer {
  priority: number
  seq: number
}

const layers = new Map<string, RegisteredLayer>()

let seq = 0

/** 纯核心（冒烟断言）：按优先级取最上层；同级取后注册者。 */
export function pickTopEscLayer(
  list: ReadonlyArray<EscLayer & { priority: number; seq: number }>
): (EscLayer & { priority: number; seq: number }) | null {
  let top: (EscLayer & { priority: number; seq: number }) | null = null
  for (const layer of list) {
    if (top === null || layer.priority > top.priority || (layer.priority === top.priority && layer.seq > top.seq)) {
      top = layer
    }
  }
  return top
}

/** 登记一个 Esc 层；返回注销函数（幂等，StrictMode 双调用安全）。 */
export function activateEscLayer(layer: EscLayer): () => void {
  layers.set(layer.id, { ...layer, priority: PRIORITY[layer.kind], seq: ++seq })
  let done = false
  return () => {
    if (done) return
    done = true
    layers.delete(layer.id)
  }
}

/**
 * 消费一次 Esc：只处理最上层一层（关闭 + 焦点归还），返回是否消费。
 * App 顶层的唯一 window 监听调用；未登记层时返回 false（保持 Esc 无副作用）。
 */
export function dispatchEscKey(): boolean {
  const top = pickTopEscLayer([...layers.values()])
  if (top === null) return false
  // 守卫必须在注销层之前：否则 onClose 内部"焦点在输入控件则不关"的守卫会空转，
  // 层已被删除，此后 Esc 永远关不掉该层（G2 三片 check P2-1）。
  if (top.deferWhenInputFocused === true) {
    const tag = (document.activeElement?.tagName ?? '').toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return false
  }
  layers.delete(top.id)
  top.onClose()
  const focusTarget = top.returnFocusRef?.current
  if (focusTarget !== undefined && focusTarget !== null && focusTarget.isConnected) {
    focusTarget.focus()
  }
  return true
}

/** 诊断用：当前登记层数。 */
export function escLayerCount(): number {
  return layers.size
}
