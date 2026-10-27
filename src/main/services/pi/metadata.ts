import type { AcpSessionRecord } from '../../../shared/types'
import { existsSync } from 'node:fs'
import { PI_VERSION, type PiState } from './protocol'

export function projectPiState(meta: AcpSessionRecord, state: PiState): void {
  meta.engine = 'pi'
  meta.pi = { sessionFile: state.sessionFile, version: PI_VERSION, sessionVersion: state.sessionVersion }
  meta.backendSessionId = state.sessionId
  meta.agentSessionId = state.sessionId
  meta.canResume = existsSync(state.sessionFile)
  meta.currentModelId = state.modelId
  meta.currentModeId ??= 'workspace'
  meta.modes = [{ id: 'read-only', name: '只读' }, { id: 'workspace', name: '询问写入与命令' }, { id: 'full-access', name: '自动批准项目工具' }]
  meta.capabilities = { controls: ['session/set_model', 'session/set_mode', 'session/set_config_option', 'session/status'], loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true }, agentInfo: { name: 'Pi SDK', version: PI_VERSION } }
  meta.configOptions = [{ id: 'thinking', name: '思考强度', category: 'thought_level', currentValue: state.thinkingLevel,
    options: [{ value: 'off', name: '关闭' }, { value: 'low', name: '低' }, { value: 'medium', name: '中' }, { value: 'high', name: '高' }] }]
}
