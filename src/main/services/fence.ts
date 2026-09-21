import { resolve, sep } from 'path'

/**
 * 工作区路径围栏（决策 TPD-010）：所有接受"项目内相对路径"参数的工具/服务
 * 必须经此校验，杜绝 `../` 目录穿越读到项目外文件。
 */

/** 相对路径合法且解析后落在 root 内 → 返回绝对路径；否则 null */
export function insideRoot(root: string, relative: string): string | null {
  if (!root || !relative) return null
  const abs = resolve(root, relative)
  const prefix = resolve(root) + sep
  if (abs === resolve(root)) return abs // root 本身允许（如列目录）
  return abs.startsWith(prefix) ? abs : null
}

/** 绝对路径必须落在 root 内 → 返回规范化绝对路径；否则 null */
export function insideRootAbs(root: string, absolute: string): string | null {
  if (!root || !absolute) return null
  const abs = resolve(absolute)
  const prefix = resolve(root) + sep
  return abs.startsWith(prefix) ? abs : null
}
