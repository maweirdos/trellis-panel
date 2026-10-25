import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

export type ZcodeInstallation = { installationRoot: string; cliPath: string }

/** Resolve only the official layout inside the selected physical installation. */
export function resolveZcodeInstallation(directory: string, platform: NodeJS.Platform = process.platform): ZcodeInstallation {
  if (!isAbsolute(directory)) throw new Error('请选择 ZCode 安装目录，未保存')
  try {
    const installationRoot = realpathSync.native(directory)
    if (!statSync(installationRoot).isDirectory()) throw new Error('not a directory')
    const entry = platform === 'darwin'
      ? join(installationRoot, 'Contents', 'Resources', 'glm', 'zcode.cjs')
      : join(installationRoot, 'resources', 'glm', 'zcode.cjs')
    const cliPath = realpathSync.native(entry)
    const within = relative(installationRoot, cliPath)
    const info = statSync(cliPath)
    if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within) || !info.isFile() || info.size === 0) throw new Error('invalid entry')
    return { installationRoot, cliPath }
  } catch {
    throw new Error('所选目录中未找到有效的 ZCode 安装入口，请选择官方 ZCode 的安装目录，未保存')
  }
}

/** Existing explicit CLI/executable overrides retain their file semantics. */
export function resolveZcodeOverride(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined
  try {
    if (statSync(path).isDirectory()) return resolveZcodeInstallation(path).cliPath
    return statSync(path).isFile() ? path : undefined
  } catch { return undefined }
}
