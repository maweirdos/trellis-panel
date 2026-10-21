/** Native bounds shared by window creation and shape changes. Renderer fills these bounds. */
export const FLOATING_TASK_WINDOWS = {
  pill: { width: 440, height: 64, minWidth: 360, minHeight: 64, title: 'Trellis · 任务状态条' },
  card: { width: 400, height: 380, minWidth: 360, minHeight: 320, title: 'Trellis · 任务悬浮窗' }
} as const
