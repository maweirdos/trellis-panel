import { OPENCODE_V2_PACKAGE, OPENCODE_V2_VERSION } from './native-releases'

export const BUILTINS = {
  codex: { name: 'Codex', packageName: '@agentclientprotocol/codex-acp', version: '2.9.0', bin: 'codex-acp' },
  claude: { name: 'Claude Code', packageName: '@agentclientprotocol/claude-agent-acp', version: '0.109.1', bin: 'claude-agent-acp' },
} as const
export const BUNDLED = { zcode: { name: 'ZCode', commandName: 'zcode' } } as const
export const NATIVES = {
  opencode: { name: 'OpenCode', commandName: 'opencode', launchArgs: ['acp'], npmPackage: OPENCODE_V2_PACKAGE, version: OPENCODE_V2_VERSION, installHint: 'OpenCode 2.3.2 不支持 ACP v2，不能作为 ACP provider 安装', missingHint: '未找到 opencode；OpenCode 2.3.2 的 ACP server 不支持 ACP v2' },
  dsh: { name: 'DeepSeek DSH', commandName: 'dsh', launchArgs: ['--profile', 'acp'], npmPackage: '@deepseek-ai/dsh', version: undefined, installHint: 'npm install -g @deepseek-ai/dsh', missingHint: '未找到 dsh；可通过「安装执行引擎」（npm install -g @deepseek-ai/dsh）安装（需要 Node >=22.19）' },
} as const
export type BuiltinId = keyof typeof BUILTINS
export type NativeId = keyof typeof NATIVES
export type BundledId = keyof typeof BUNDLED
export const RESERVED_RUNTIME_IDS = new Set<string>(
  [...Object.keys(BUILTINS), ...Object.keys(NATIVES), ...Object.keys(BUNDLED), 'pi'].map(id => id.toLowerCase()),
)
