import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, isAbsolute, delimiter, basename } from 'node:path'
import type { ExternalConversation } from '../../../../shared/task-conversations'
import { TaskConversationError, type LaunchCapability, type LaunchPorts, type LaunchTarget } from '../types'
import { nativeSessionId } from './paths'
import { registeredProtocolExecutable, launchClaudeTerminal } from './windows-launch'
import { probeCodexPackage, launchCodexPackage } from './codex-package'

/** Public reference: github.com/zai-org/ZCode, packages/desktop/src/main/desktopDeepLinkUrl.ts. */
function installedZcodeWorkspaceRoute(executable: string): boolean {
  const asar = join(dirname(executable), 'resources', 'app.asar')
  // Electron's patched fs interprets app.asar as a virtual directory; inspect raw bytes.
  const requireNative = createRequire(process.execPath)
  const { existsSync: rawExists, openSync, readSync, closeSync } = requireNative('original-fs') as typeof import('node:fs')
  if (!rawExists(asar)) return false
  const fd = openSync(asar, 'r')
  try {
    const prefix = Buffer.alloc(16)
    if (readSync(fd, prefix, 0, 16, 0) !== 16) return false
    const headerSize = prefix.readUInt32LE(4)
    const jsonSize = prefix.readUInt32LE(12)
    if (jsonSize > 16 * 1024 * 1024 || headerSize > 16 * 1024 * 1024 || headerSize < jsonSize) return false
    const header = Buffer.alloc(jsonSize)
    if (readSync(fd, header, 0, jsonSize, 16) !== jsonSize) return false
    type Entry = { files?: Record<string, Entry>; size?: number; offset?: string; unpacked?: boolean }
    let node: Entry | undefined = JSON.parse(header.toString('utf8')) as Entry
    for (const part of ['out', 'main', 'index.js']) node = node?.files?.[part]
    if (!node?.size || node.unpacked || node.size > 32 * 1024 * 1024 || !/^\d+$/.test(node.offset ?? '')) return false
    const source = Buffer.alloc(node.size)
    const bytes = readSync(fd, source, 0, source.length, 8 + headerSize + Number(node.offset))
    const text = source.subarray(0, bytes).toString('utf8')
    return text.includes('--open-workspace') && /["']workspace["']/.test(text) && /["']\/open["']/.test(text)
  } catch { return false }
  finally { closeSync(fd) }
}

function claudeExecutable(): string | undefined {
  const candidates = [
    join(homedir(), '.local', 'bin', 'claude.exe'),
    ...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')] : []),
    ...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(dir => join(dir, 'claude.exe'))
  ]
  return candidates.find(path => existsSync(path))
}
export function defaultLaunchPorts(): LaunchPorts {
  let electron: typeof import('electron') | undefined
  return {
    async capability(source): Promise<LaunchCapability> {
      if (source === 'claude-code') {
        if (process.platform !== 'win32') return { available: false, detail: '当前平台尚未配置可验证的终端续接入口' }
        const executable = claudeExecutable()
        if (!executable) return { available: false, detail: '未找到 Claude 原生 CLI，无法终端续接' }
        return { available: true, executable, detail: '在正确项目目录打开终端，恢复已保存历史；不聚焦原有 VS Code 窗口' }
      }
      try {
        // Electron exposes this native module through its CommonJS builtin loader.
        // Dynamic ESM resolution can instead look for an npm package beside a bundle.
        electron ??= require('electron') as typeof import('electron')
        let executable: string | null = null
        try { executable = (await electron.app.getApplicationInfoForProtocol(`${source}://`)).path } catch {
          if (process.platform === 'win32') executable = await registeredProtocolExecutable(source)
        }
        const trustedExecutable = executable && existsSync(executable) && (process.platform !== 'win32' || basename(executable).toLowerCase() === `${source}.exe`)
        if (!trustedExecutable) {
          if (source === 'codex' && process.platform === 'win32') {
            const packaged = await probeCodexPackage()
            if (packaged) return { available: true, ...packaged, detail: '通过已验证的 Windows 安装包打开原生会话' }
          }
          return { available: false, detail: '未找到已注册的原生客户端协议' }
        }
        if (source === 'zcode' && (!executable || !installedZcodeWorkspaceRoute(executable))) return { available: false, detail: '已安装 ZCode 的工作区路由未通过核验' }
        return { available: true }
      } catch { return { available: false, detail: '未找到已注册的原生客户端协议' } }
    },
    launch(target): Promise<void> {
      if (target.kind === 'packaged-protocol') return launchCodexPackage(target)
      if (target.kind === 'protocol') {
        if (!electron) return Promise.reject(new TaskConversationError('E_UNAVAILABLE', '原生协议未就绪'))
        return electron.shell.openExternal(target.url)
      }
      return launchClaudeTerminal(target)
    }
  }
}
export function applyCapability(item: ExternalConversation, capability: LaunchCapability): ExternalConversation {
  if (!capability.available) return { ...item, capability: 'unavailable', unavailableReason: capability.detail || '原生打开入口不可用', destinationLabel: undefined }
  const { unavailableReason: _reason, ...rest } = item
  return { ...rest, capability: item.source === 'zcode' ? 'workspace' : 'session', destinationLabel: item.source === 'claude-code' ? '终端续接' : item.source === 'zcode' ? '工作区' : 'Codex' }
}
export function launchTarget(item: ExternalConversation, capability: LaunchCapability): LaunchTarget {
  if (!capability.available || !nativeSessionId(item.source, item.sessionId)) throw new TaskConversationError('E_UNAVAILABLE', capability.detail || '原生会话打开能力不可用')
  if (item.source === 'claude-code') {
    if (!capability.executable || !isAbsolute(capability.executable)) throw new TaskConversationError('E_UNAVAILABLE', 'Claude CLI 路径未通过核验')
    return { kind: 'terminal', source: 'claude-code', executable: capability.executable, args: ['--resume', item.sessionId], cwd: item.cwd }
  }
  // Codex's documented technical ID route; never construct a /new or prompt URL.
  if (item.source === 'codex') {
    const url = `codex://threads/${encodeURIComponent(item.sessionId)}`
    return capability.packageFamilyName
      ? { kind: 'packaged-protocol', source: 'codex', url, cwd: item.cwd, packageFamilyName: capability.packageFamilyName }
      : { kind: 'protocol', source: 'codex', url, cwd: item.cwd }
  }
  const url = new URL('zcode://workspace/open')
  url.searchParams.set('path', item.cwd)
  return { kind: 'protocol', source: 'zcode', url: url.href, cwd: item.cwd }
}
