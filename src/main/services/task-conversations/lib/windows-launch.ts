import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, isAbsolute, join } from 'node:path'
import { existsSync } from 'node:fs'
import type { LaunchTarget } from '../types'
import { TaskConversationError } from '../types'

const execute = promisify(execFile)
function systemExecutable(name: string): string { return join(process.env.SystemRoot || 'C:\\Windows', 'System32', name) }
export function windowsPowerShellEnvironment(): NodeJS.ProcessEnv {
  // A PowerShell 7 parent may pass modules that Windows PowerShell 5 cannot load.
  return { ...process.env, PSModulePath: systemExecutable('WindowsPowerShell\\v1.0\\Modules') }
}
/** Read only the registered protocol, never execute a registry command string. */
export async function registeredProtocolExecutable(source: 'codex' | 'zcode'): Promise<string | null> {
  try {
    const registration = await execute(systemExecutable('reg.exe'), ['query', `HKCR\\${source}`, '/v', 'URL Protocol'], { windowsHide: true, timeout: 1500, maxBuffer: 16 * 1024 })
    if (!registration.stdout.includes('REG_SZ')) return null
    const command = await execute(systemExecutable('reg.exe'), ['query', `HKCR\\${source}\\shell\\open\\command`, '/ve'], { windowsHide: true, timeout: 1500, maxBuffer: 16 * 1024 })
    const value = command.stdout.match(/REG_SZ\s+(.+)/)?.[1]?.trim()
    const match = value?.match(/^"([^"]+\.exe)"\s+(?:--\s+)?"%1"$/i)
    const executable = match?.[1]
    return executable && isAbsolute(executable) && basename(executable).toLowerCase() === `${source}.exe` && existsSync(executable) ? executable : null
  } catch { return null }
}
function quoted(value: string): string { return `'${value.replace(/'/g, "''")}'` }
export function claudeTerminalInvocation(target: Extract<LaunchTarget, { kind: 'terminal' }>): { executable: string; args: string[] } {
  if (target.args.length !== 2 || target.args[0] !== '--resume' || !/^[0-9a-f-]{36}$/i.test(target.args[1])) {
    throw new TaskConversationError('E_INVALID_ARG', '终端续接参数无效')
  }
  const command = `$ErrorActionPreference='Stop'; Start-Process -FilePath ${quoted(target.executable)} -WorkingDirectory ${quoted(target.cwd)} -ArgumentList @('--resume',${quoted(target.args[1])}) -WindowStyle Normal -PassThru | Out-Null`
  const encoded = Buffer.from(command, 'utf16le').toString('base64')
  return { executable: systemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded] }
}
/** Main constructs only a native interactive history resume; the helper stays hidden. */
export function launchClaudeTerminal(target: Extract<LaunchTarget, { kind: 'terminal' }>): Promise<void> {
  const invocation = claudeTerminalInvocation(target)
  return execute(invocation.executable, invocation.args, {
    windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024, env: windowsPowerShellEnvironment()
  }).then(() => undefined)
}
