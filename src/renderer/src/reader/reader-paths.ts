/**
 * 渲染端路径小工具（S0 G2 第三片）：渲染层无 node:path（contextIsolation），
 * 三入口把各自的绝对路径（任务产物 / 查看器标签）折算成 documentRead 契约要求的
 * 项目根相对路径（正斜杠）。根外文件返回 null——调用方降级为旧读取路径，
 * 不伪装在项目内。
 */

function isWindowsRoot(root: string): boolean {
  return /^[a-z]:($|\/)/i.test(root.replace(/\\/g, '/')) || root.replace(/\\/g, '/').startsWith('//')
}

/** Compare full document paths without weakening case-sensitive POSIX roots. */
export function sameRelativeDocumentPath(projectRoot: string, left: string, right: string): boolean {
  const normalize = (path: string): string => {
    const normalized = path.replace(/\\/g, '/')
    return isWindowsRoot(projectRoot) ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}

/** 绝对路径 → 项目根相对 posix 路径；不在根内返回 null。 */
export function relativePathUnderRoot(projectRoot: string, absPath: string): string | null {
  if (!projectRoot) return null
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const abs = absPath.replace(/\\/g, '/')
  const boundaryRoot = isWindowsRoot(projectRoot) ? root.toLowerCase() : root
  const boundaryPath = isWindowsRoot(projectRoot) ? abs.toLowerCase() : abs
  if (boundaryPath === boundaryRoot) return null
  if (!boundaryPath.startsWith(`${boundaryRoot}/`)) return null
  return abs.slice(root.length + 1)
}
