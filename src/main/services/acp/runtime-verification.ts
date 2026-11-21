import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { AcpAgentConfig, AcpAgentStatus, AcpConnectionProbeResult, AcpRuntimeDefaults } from '../../../shared/types'

export type RuntimeConnectionProbeResult = AcpConnectionProbeResult & { errorCode?: number }
type Verification = { identity: string; checkedAt: number; probe: RuntimeConnectionProbeResult }
const verifications = new Map<string, Verification>()
const MAX_VERIFICATIONS = 64
const VERIFICATION_TTL_MS = 5 * 60_000

function currentVerification(id: string): Verification | undefined {
  const verification = verifications.get(id)
  if (verification && Date.now() - verification.checkedAt >= VERIFICATION_TTL_MS) {
    verifications.delete(id)
    return undefined
  }
  return verification
}

/** In-memory only. File replacement and changed launch selection invalidate prior evidence. */
export function runtimeVerificationIdentity(config: AcpAgentConfig, argv: string[] | undefined, selection: {
  nodePath?: string; nativePath?: string; enableAutomationTools?: boolean; runtimeDefaults?: AcpRuntimeDefaults
}): string {
  const files = argv?.filter(isAbsolute).map(path => {
    try {
      const file = statSync(path, { bigint: true })
      return [path, realpathSync.native(path), String(file.dev), String(file.ino), String(file.size), String(file.mtimeNs), String(file.ctimeNs)]
    } catch { return [path, 'unavailable'] }
  })
  return createHash('sha256').update(JSON.stringify({ config, argv, selection, files, platform: process.platform,
    path: process.env.PATH ?? process.env.Path, pathExt: process.env.PATHEXT, systemRoot: process.env.SystemRoot })).digest('hex')
}

export function rememberRuntimeVerification(id: string, identity: string, probe: RuntimeConnectionProbeResult): void {
  verifications.delete(id)
  verifications.set(id, { identity, checkedAt: Date.now(), probe })
  while (verifications.size > MAX_VERIFICATIONS) {
    const oldest = verifications.keys().next().value
    if (oldest === undefined) break
    verifications.delete(oldest)
  }
}

export function hasRuntimeVerification(id: string): boolean {
  return currentVerification(id) !== undefined
}

export function applyRuntimeVerification(agent: AcpAgentStatus, identity: string): AcpAgentStatus {
  const verification = currentVerification(agent.id)
  if (!verification) return agent
  if (verification.identity !== identity) {
    verifications.delete(agent.id)
    return agent
  }
  const { checkedAt, probe } = verification
  const sdk = agent.launchKind === 'sdk'
  const detail = probe.ok
    ? sdk ? 'SDK 启动条件已验证；模型连接和凭据尚未验证'
      : `ACP initialize 握手成功（协议 v${probe.protocolVersion}）；登录状态和模型请求尚未验证`
    : `连接验证失败：${probe.error ?? '未收到有效的 initialize 响应'}`
  return { ...agent,
    health: !agent.available ? agent.health : probe.ok ? 'ready' : probe.errorCode === -32000 ? 'auth_required'
      : probe.protocolVersion !== undefined && probe.protocolVersion !== 1 ? 'incompatible' : 'launch_error',
    diagnostics: [...(agent.diagnostics ?? []), `${new Date(checkedAt).toISOString()} · ${detail}`]
  }
}
