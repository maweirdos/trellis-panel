import { z } from 'zod'
import type { AcpAgentProfile, AcpRuntimeDefaults, AcpSessionRecord } from './types'

export const acpModelIdSchema = z.string().min(1).max(512).refine(value => value.trim().length > 0 && !value.includes('\0'), '请选择完整的模型 ID')
export const acpEnvVarSchema = z.object({
  key: z.string().trim().min(1).max(200).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '环境变量名只能包含字母、数字和下划线，且不以数字开头'),
  value: z.string().max(4000).refine(value => !value.includes('\0'))
})
export const acpExtraArgSchema = z.object({
  name: z.string().trim().min(1).max(200).refine(value => !value.includes('\0')),
  value: z.string().max(4000).refine(value => !value.includes('\0'))
})
export const acpRuntimeDefaultsSchema = z.object({
  modelId: acpModelIdSchema.optional(), env: z.array(acpEnvVarSchema).max(50).optional(), args: z.array(acpExtraArgSchema).max(50).optional()
}).strict()
export const acpRuntimeDefaultsMapSchema = z.record(z.string().min(1).max(200).regex(/^[\w.-]+$/), acpRuntimeDefaultsSchema)
  .refine(value => Object.keys(value).length <= 100, '最多配置 100 个执行引擎默认值')
const launchSnapshotSchema = acpRuntimeDefaultsSchema.extend({ env: z.array(acpEnvVarSchema).max(100).optional(), args: z.array(acpExtraArgSchema).max(100).optional() })
const environmentKey = (key: string, platform?: string): string => platform === 'win32' ? key.toUpperCase() : key

/** Role entries replace all same-key defaults, retaining order and repetition within each scope. */
export function resolveAcpLaunchOptions(defaults: AcpRuntimeDefaults | undefined, profile?: Pick<AcpAgentProfile, 'modelId' | 'env' | 'args'>, platform?: string): AcpRuntimeDefaults {
  const base = acpRuntimeDefaultsSchema.parse(defaults ?? {})
  const role = z.object({ modelId: acpModelIdSchema.nullable().optional(), env: z.array(acpEnvVarSchema).max(50).optional(), args: z.array(acpExtraArgSchema).max(50).optional() }).parse(profile ?? {})
  const envKeys = new Set(role.env?.map(item => environmentKey(item.key, platform)))
  const argNames = new Set(role.args?.map(item => item.name))
  const modelId = role.modelId === undefined ? base.modelId : role.modelId ?? undefined
  return { ...(modelId === undefined ? {} : { modelId }),
    env: [...(base.env ?? []).filter(item => !envKeys.has(environmentKey(item.key, platform))), ...(role.env ?? [])].map(item => ({ ...item, key: environmentKey(item.key, platform) })),
    args: [...(base.args ?? []).filter(item => !argNames.has(item.name)), ...(role.args ?? [])] }
}

/** Never apply current global defaults to a previously created session. */
export function sessionAcpLaunchOptions(meta: Pick<AcpSessionRecord, 'launchOptionsSnapshot' | 'profileSnapshot'>, platform?: string): AcpRuntimeDefaults {
  const options = launchSnapshotSchema.parse(meta.launchOptionsSnapshot ?? { env: meta.profileSnapshot?.env, args: meta.profileSnapshot?.args })
  return { ...options, ...(options.env ? { env: options.env.map(item => ({ ...item, key: environmentKey(item.key, platform) })) } : {}) }
}

export function acpProcessEnv(options: AcpRuntimeDefaults, platform?: string): Record<string, string> {
  return Object.fromEntries((options.env ?? []).map(item => [environmentKey(item.key, platform), item.value]))
}

/** Node selects only one casing on Windows; canonicalize both ambient and explicit overlays. */
export function acpSpawnEnv(base: Record<string, string | undefined>, overlay: Record<string, string>, platform?: string): Record<string, string> {
  return Object.fromEntries([...Object.entries(base), ...Object.entries(overlay)].filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => [environmentKey(key, platform), value]))
}

export function acpExtraArgv(options: AcpRuntimeDefaults): string[] {
  return (options.args ?? []).flatMap(item => item.value.length > 0 ? [item.name, item.value] : [item.name])
}
