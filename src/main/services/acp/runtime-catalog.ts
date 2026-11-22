import { OPENCODE_V2_PACKAGE } from './native-releases'

export const BUILTINS = {
  codex: { name: 'Codex', packageName: '@agentclientprotocol/codex-acp', version: '2.2.2', bin: 'codex-acp' },
  claude: { name: 'Claude Code', packageName: '@agentclientprotocol/claude-agent-acp', version: '0.91.0', bin: 'claude-agent-acp' },
} as const
export const BUNDLED = { zcode: { name: 'ZCode', commandName: 'zcode' } } as const
export const NATIVES = {
  opencode: { name: 'OpenCode', commandName: 'opencode', launchArgs: ['acp'], npmPackage: OPENCODE_V2_PACKAGE, installHint: `npm install -g ${OPENCODE_V2_PACKAGE}`, missingHint: `未找到 opencode；可通过「安装」安装 OpenCode v2（npm install -g ${OPENCODE_V2_PACKAGE}）或使用官方安装方式` },
  dsh: { name: 'DeepSeek DSH', commandName: 'dsh', launchArgs: ['--profile', 'acp'], npmPackage: '@deepseek-ai/dsh', installHint: 'npm install -g @deepseek-ai/dsh', missingHint: '未找到 dsh；可通过「安装执行引擎」（npm install -g @deepseek-ai/dsh）安装（需要 Node >=22.19）' },
} as const
export type BuiltinId = keyof typeof BUILTINS
export type NativeId = keyof typeof NATIVES
export type BundledId = keyof typeof BUNDLED
export const RESERVED_RUNTIME_IDS = new Set<string>(
  [...Object.keys(BUILTINS), ...Object.keys(NATIVES), ...Object.keys(BUNDLED), 'pi'].map(id => id.toLowerCase()),
)
