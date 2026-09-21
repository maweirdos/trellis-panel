/**
 * ipcMain 注册包装器：强制所有通道先在 src/shared/ipc-channels.ts 登记再注册（TPD-001）。
 * dev 模式下注册未声明通道立即抛错，杜绝"handler 绕过注册表"的回归。
 */
import { ipcMain } from 'electron'
import { allIpcChannels } from '../../shared/ipc-channels'

const assertDeclared = (channel: string): void => {
  if (!allIpcChannels.has(channel)) {
    throw new Error(`IPC 通道未在 shared/ipc-channels.ts 登记: ${channel}`)
  }
}

export function handle(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  assertDeclared(channel)
  ipcMain.handle(channel, listener)
}

export function on(channel: string, listener: (event: Electron.IpcMainEvent, ...args: any[]) => void): void {
  assertDeclared(channel)
  ipcMain.on(channel, listener)
}
