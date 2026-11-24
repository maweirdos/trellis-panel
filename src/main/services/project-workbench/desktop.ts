import { execFile, spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { DaemonError } from '../../daemon/errors'
import { checkedDirectory } from '../private-conversations/files'

function existingExecutable(paths: readonly string[]): string | undefined {
  for (const candidate of paths) {
    if (!isAbsolute(candidate)) continue
    try {
      const path = realpathSync.native(candidate)
      if (statSync(path).isFile()) return path
    } catch { continue }
  }
  return undefined
}

export function workbenchEditor(): string | undefined {
  if (process.platform === 'win32') {
    const standard = [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .flatMap(path => path ? [join(path, 'Microsoft VS Code', 'Code.exe')] : [])
    return existingExecutable(standard)
  }
  return existingExecutable([
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', '/usr/bin/code', '/usr/local/bin/code',
  ])
}

export function workbenchTerminal(): { executable: string; args: string[] } | undefined {
  if (process.platform === 'win32') {
    const executable = existingExecutable([join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')])
    return executable ? { executable, args: [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '(Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -ArgumentList @("-NoLogo","-NoProfile","-NoExit") -WorkingDirectory (Get-Location).ProviderPath -WindowStyle Normal -PassThru -ErrorAction Stop).Id',
    ] } : undefined
  }
  const executable = existingExecutable(['/usr/bin/x-terminal-emulator', '/usr/bin/gnome-terminal', '/usr/bin/konsole'])
  return executable ? { executable, args: [] } : undefined
}

export function workbenchLaunch(executable: string, args: string[], cwd: string, current: () => void, visible: boolean): Promise<void> {
  current()
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, detached: true, stdio: 'ignore', windowsHide: !visible })
    child.once('error', () => reject(new DaemonError('E_UNAVAILABLE', '本机应用无法启动。')))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

export async function workbenchLaunchTerminal(terminal: NonNullable<ReturnType<typeof workbenchTerminal>>, cwd: string, current: () => void): Promise<number | undefined> {
  if (process.platform !== 'win32') {
    await workbenchLaunch(terminal.executable, terminal.args, cwd, current, true)
    return undefined
  }
  current()
  return new Promise((resolve, reject) => {
    execFile(terminal.executable, terminal.args, { cwd, windowsHide: true, timeout: 7000, maxBuffer: 8192 }, (error, output) => {
      const pid = Number(output.trim())
      if (!error && Number.isSafeInteger(pid) && pid > 0) resolve(pid)
      else if (!error || error.killed) reject(new DaemonError('E_UNKNOWN', '未确认终端窗口是否已打开，请先查看本机窗口。', 'unknown'))
      else reject(new DaemonError('E_UNAVAILABLE', '本机终端无法启动。'))
    })
  })
}

export function assertScriptDirectory(root: string, cwd: string): void {
  const part = relative(root, checkedDirectory(cwd))
  if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) {
    throw new DaemonError('E_DENIED', '脚本的实际工作目录超出原会话工作区。')
  }
}
