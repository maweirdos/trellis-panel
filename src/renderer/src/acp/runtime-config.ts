import type { AcpAgentProfile, AcpAgentStatus, AcpRuntimeDefaults, AiConfig } from '../../../shared/types'

export type RuntimeConfigValue = Pick<AcpAgentProfile, 'modelId' | 'env' | 'args'>
export interface RuntimeConfigOptions { role?: boolean; launchKind?: AcpAgentStatus['launchKind'] }

export function runtimeModelOptions(ai: AiConfig | undefined, launchKind: AcpAgentStatus['launchKind']): Array<{ value: string; label: string }> {
  if (!ai || launchKind !== 'sdk') return []
  if (ai.providers?.length) return ai.providers.filter(provider => provider.enabled).flatMap(provider =>
    provider.models.filter(model => model.enabled).map(model => ({ value: `${provider.id}:${model.id}`, label: `${provider.name} · ${model.name || model.id}` })))
  return ai.enabled && ai.model ? [{ value: `default:${ai.model}`, label: `默认模型 · ${ai.model}` }] : []
}

export function runtimeConfigError(value: RuntimeConfigValue, launchKind: AcpAgentStatus['launchKind']): string {
  if (typeof value.modelId === 'string' && !value.modelId.trim()) return '请填写模型 ID，或选择自动模式。'
  if (typeof value.modelId === 'string' && (value.modelId.length > 512 || value.modelId.includes('\0'))) return '模型 ID 最多 512 字符，且不能包含空字符。'
  const groups = [
    { label: '环境变量', rows: (value.env ?? []).map(row => ({ name: row.key, value: row.value })) },
    { label: '参数', rows: launchKind === 'sdk' ? [] : value.args ?? [] }
  ]
  for (const { label, rows } of groups) {
    if (rows.length > 50) return `${label}最多 50 项。`
    for (const [index, row] of rows.entries()) {
      const name = row.name.trim()
      if (!name) return `请填写第 ${index + 1} 项${label}名称，或移除此行。`
      if (name.length > 200 || row.value.length > 4000) return `${label}名称最多 200 字符，值最多 4000 字符。`
      if (name.includes('\0') || row.value.includes('\0')) return `${label}不能包含空字符。`
      if (label === '环境变量' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `环境变量 ${name} 的名称格式无效。`
    }
  }
  return ''
}

export function cleanRuntimeConfig(value: RuntimeConfigValue, { role = false, launchKind }: RuntimeConfigOptions = {}): RuntimeConfigValue {
  return {
    modelId: value.modelId === undefined && role ? '' : typeof value.modelId === 'string' ? value.modelId.trim() : value.modelId,
    env: value.env?.map(row => ({ key: row.key.trim(), value: row.value })),
    args: launchKind === 'sdk' ? role ? [] : undefined : value.args?.map(row => ({ name: row.name.trim(), value: row.value }))
  }
}

export function runtimeDefaultsSummary(value: AcpRuntimeDefaults | undefined, launchKind: AcpAgentStatus['launchKind'], ai?: AiConfig): string {
  if (!value) return ''
  const parts: string[] = []
  if (value.modelId) parts.push(`模型 ${runtimeModelOptions(ai, launchKind).find(option => option.value === value.modelId)?.label ?? value.modelId}`)
  if (value.env?.length) parts.push(`${value.env.length} 个变量`)
  if (launchKind !== 'sdk' && value.args?.length) parts.push(`${value.args.length} 个参数`)
  return parts.join(' · ')
}
