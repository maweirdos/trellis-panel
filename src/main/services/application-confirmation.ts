import { dialog, type BrowserWindow } from 'electron'
import type { ApplicationLaunchPreview } from '../../shared/app-runtime'
import { canonicalDirectory } from './acp/metadata'

interface ConfirmationScope {
  senderId: number
  generation: number
  getMain(): BrowserWindow | null
  getRoot(): string | null
  getGeneration(): number
}

export function applicationConfirmation(scope: ConfirmationScope): (preview: ApplicationLaunchPreview) => Promise<boolean> {
  return async (preview): Promise<boolean> => {
    const window = scope.getMain()
    const isCurrent = (): boolean => {
      const root = scope.getRoot()
      return root !== null && scope.getGeneration() === scope.generation && canonicalDirectory(root) === canonicalDirectory(preview.root)
    }
    if (!window || window.webContents.id !== scope.senderId || !isCurrent()) return false
    const response = await dialog.showMessageBox(window, {
      type: 'question',
      title: '确认应用启动配置',
      message: `${preview.action === 'restart' ? '重启' : '启动'} ${preview.name}？`,
      detail: [
        `目录：${preview.cwd}`,
        `命令：${preview.command}`,
        preview.envFiles.length ? `环境文件：${preview.envFiles.join('、')}` : '',
        preview.overrideKeys.length ? `环境覆盖：${preview.overrideKeys.join('、')}` : '',
        preview.ports.length ? `端口：${preview.ports.map((port) => `${port.host}:${port.port}`).join('、')}` : ''
      ].filter(Boolean).join('\n'),
      buttons: ['取消', '允许此配置并启动'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    return response.response === 1 && isCurrent()
  }
}
