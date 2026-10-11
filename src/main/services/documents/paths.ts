import { existsSync, realpathSync, statSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'

/**
 * 文档路径边界与观测 runtime 目录识别（design §4.1/§5.1）。
 *
 * 边界规则：documentRead 只允许已打开工作区（项目根）内的授权路径。
 * 词法包含（resolve + startsWith）拦绝对路径与 .. 逃逸；realpath 拦软链接逃逸
 * （链接/junction 指向根外的目标一律拒绝）。文件缺失时以最近存在祖先的 realpath
 * 做包含校验，避免"目录是根外软链 + 文件尚未创建"的组合绕过。
 */

/**
 * 观测 runtime 目录的精确忽略规则（design §4.1）：
 * 只忽略 `.panel/runtime` 这一段，不扩大到整个 `.panel`——未来 `.panel` 下
 * 可能携带任务批准资料，仍应被普通扫描看见。
 * 同时匹配两种分隔符（chokidar 在 Windows 上报原生反斜杠路径）。
 */
export const PANEL_RUNTIME_PATH_RE = /(^|[/\\])\.panel[/\\]runtime(?:[/\\]|$)/

/** 判断路径是否落在观测 runtime 目录（`.panel/runtime`）内。 */
export function isPanelRuntimePath(p: string): boolean {
  return PANEL_RUNTIME_PATH_RE.test(p)
}

export type AuthorizedDocumentPath =
  | { ok: true; absPath: string; canonicalPath: string; exists: boolean }
  | { ok: false; reason: 'outside-root' }

/** realRoot 的 realpath（根不存在时退化为词法根，交给后续 stat 报告事实）。 */
export function realRootOf(root: string): string {
  try {
    return realpathSync(resolve(root))
  } catch {
    return resolve(root)
  }
}

/** 文件缺失时：向上找最近存在的祖先，realpath 校验包含后拼出 canonical 路径。 */
function canonicalForMissing(abs: string, realRoot: string): { canonicalPath: string } | { escape: true } {
  let cur = dirname(abs)
  for (let guard = 0; guard < 128; guard++) {
    if (existsSync(cur)) {
      let real: string
      try {
        real = realpathSync(cur)
      } catch {
        return { canonicalPath: abs }
      }
      if (real !== realRoot && !real.startsWith(realRoot + sep)) return { escape: true }
      return { canonicalPath: join(real, relative(cur, abs)) }
    }
    if (cur === realRoot || dirname(cur) === cur) return { canonicalPath: join(realRoot, relative(realRoot, abs)) }
    cur = dirname(cur)
  }
  return { canonicalPath: abs }
}

/**
 * 解析并校验 documentRead 的目标路径。
 * 不做存在性以外的 IO；越界一律拒绝（不回落到读根外内容）。
 */
export function resolveAuthorizedDocumentPath(root: string, relativePath: string): AuthorizedDocumentPath {
  const rel = String(relativePath ?? '').trim()
  if (!rel || rel.includes('\0')) return { ok: false, reason: 'outside-root' }
  const realRoot = realRootOf(root)
  const abs = resolve(realRoot, rel)
  if (abs !== realRoot && !abs.startsWith(realRoot + sep)) return { ok: false, reason: 'outside-root' }

  try {
    statSync(abs)
  } catch {
    // 缺失（或不可 stat）：交给调用方按 file_missing / file_unreadable 表达
    const miss = canonicalForMissing(abs, realRoot)
    if ('escape' in miss) return { ok: false, reason: 'outside-root' }
    return { ok: true, absPath: abs, canonicalPath: miss.canonicalPath, exists: false }
  }
  try {
    const real = realpathSync(abs)
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return { ok: false, reason: 'outside-root' }
    return { ok: true, absPath: abs, canonicalPath: real, exists: true }
  } catch {
    // 存在但 realpath 失败（如权限）：视为不可读而非越界
    return { ok: true, absPath: abs, canonicalPath: abs, exists: true }
  }
}
