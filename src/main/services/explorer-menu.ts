/**
 * T1：资源管理器右键"用 Trellis Panel 阅读"。
 * 约束：仅打包态（开发态注册会劫持 electron.exe）；仅写 HKCU 当前用户键；
 * 幂等（/f 覆盖）；关闭即删除键。命令走 trellis-panel:// 深链，
 * 由既有的 second-instance → parseDeepLink → 上溯找 .trellis 链路接手。
 */
import { app } from 'electron'
import { execFile } from 'child_process'

const REG_KEY = 'HKCU\\Software\\Classes\\Directory\\shell\\TrellisPanelOpen'
const LABEL = '用 Trellis Panel 阅读'

function reg(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    // 注册表操作失败不抛给设置流程——开关状态仍如实返回
    execFile('reg', args, { windowsHide: true }, () => resolve())
  })
}

export function explorerMenuSupported(): boolean {
  return process.platform === 'win32' && app.isPackaged
}

export async function setExplorerMenu(on: boolean, token: string): Promise<boolean> {
  if (!explorerMenuSupported()) return false
  if (!on) {
    await reg(['delete', REG_KEY, '/f'])
    return true
  }
  const exe = process.execPath
  const cmd = `"${exe}" "trellis-panel://open-task?dir=%V&t=${token}"`
  await reg(['add', REG_KEY, '/ve', '/d', LABEL, '/f'])
  await reg(['add', REG_KEY, '/v', 'Icon', '/d', exe, '/f'])
  await reg(['add', `${REG_KEY}\\command`, '/ve', '/d', cmd, '/f'])
  return true
}
