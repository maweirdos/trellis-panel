import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { acpProcessEnv, acpSpawnEnv, resolveAcpLaunchOptions } from '../../../../shared/acp-launch-options'
import { resolveAcpRuntimeLaunch } from '../../acp/setup'
import { getSettings } from '../../store'
import { integrationFetch } from '../transport'

const stringMap = z.record(z.string(), z.string()).nullish()
const provider = z.object({
  base_url: z.string().nullish(), wire_api: z.string().nullish(), env_key: z.string().nullish(),
  http_headers: stringMap, env_http_headers: stringMap, query_params: stringMap,
  requires_openai_auth: z.boolean().optional(), experimental_bearer_token: z.string().nullish(),
  auth: z.unknown().optional(), aws: z.unknown().optional(), gateway_oauth: z.unknown().optional(), credential_file: z.unknown().optional()
})
const runtimeConfig = z.object({
  model: z.string().nullish(), model_provider: z.string().nullish(), openai_base_url: z.string().nullish(),
  model_providers: z.record(z.string(), z.unknown()).optional()
})
const configurationError = '无法读取此 Agent 的 Codex 配置，请检查 Crux 执行引擎中的 Codex。'
const providerError = '此 Codex 配置未提供可用于飞书文字回复的 Responses API。请检查 Codex 的模型、服务地址和 API 认证。'

export class CodexFeishuError extends Error {}

/** Read the managed runtime's effective provider without starting a thread or giving it chat content. */
async function readConfiguration(executable: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, modelOverride?: string) {
  return new Promise<z.infer<typeof runtimeConfig>>((resolve, reject) => {
    const child = execFile(executable, args, { cwd: tmpdir(), env, windowsHide: true, signal,
      maxBuffer: 2 * 1024 * 1024 }, () => reject(new Error(configurationError)))
    const write = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`)
    child.stdin?.on('error', () => reject(new Error(configurationError)))
    let buffer = ''
    let effective: z.infer<typeof runtimeConfig> | undefined
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const reply = JSON.parse(line)
          if (reply.id === 1 && reply.result) {
            write({ method: 'initialized' })
            write({ id: 2, method: 'config/read', params: { includeLayers: false } })
          } else if (reply.id === 2) {
            effective = runtimeConfig.parse(reply.result.config)
            if (!modelOverride && !effective.model) {
              write({ id: 3, method: 'model/list', params: { limit: 100 } })
              continue
            }
            child.stdin?.end()
            resolve(effective)
          } else if (reply.id === 3 && effective) {
            const models = z.array(z.object({ model: z.string(), isDefault: z.boolean() })).parse(reply.result.data)
            child.stdin?.end()
            resolve({ ...effective, model: models.find(item => item.isDefault)?.model })
          } else if (reply.id === 1 && reply.error) throw Error()
        } catch {
          child.stdin?.end()
          reject(new Error(configurationError))
        }
      }
    })
    write({ id: 1, method: 'initialize', params: { clientInfo: { name: 'crux', version: '1' }, capabilities: {} } })
  })
}

export async function codexFeishuReply(system: string, user: string, parentSignal?: AbortSignal): Promise<string> {
  try { return await requestCodexText(system, user, parentSignal) }
  catch (error) {
    if (error instanceof CodexFeishuError) throw error
    throw new CodexFeishuError(configurationError)
  }
}

async function requestCodexText(system: string, user: string, parentSignal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(45_000)
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout
  const launch = await resolveAcpRuntimeLaunch('codex')
  if (!('argv' in launch) || launch.config.launchKind !== 'managed') throw new Error(configurationError)
  const options = resolveAcpLaunchOptions(getSettings().acp?.runtimeDefaults?.codex, undefined, process.platform)
  if (options.args?.length) throw new CodexFeishuError('此 Codex 执行引擎使用自定义启动参数，暂不能核对其飞书文字回复配置。')
  const env = acpSpawnEnv(process.env, acpProcessEnv(options, process.platform), process.platform)
  const [node, adapter] = launch.argv
  const codex = env.CODEX_PATH
  if (codex && (!isAbsolute(codex) || (process.platform === 'win32' && !/\.exe$/i.test(codex)))) throw new Error(configurationError)
  let config: z.infer<typeof runtimeConfig>
  try {
    const args = codex ? ['app-server'] : [createRequire(adapter).resolve('@openai/codex/bin/codex.js'), 'app-server']
    config = await readConfiguration(codex || node, args, env, signal, options.modelId)
  } catch { throw new Error(configurationError) }
  const model = options.modelId || config.model
  const id = config.model_provider ?? 'openai'
  const official = id === 'openai'
  const parsed = provider.safeParse(config.model_providers?.[id] ?? (official ? {} : undefined))
  if (!model || !parsed.success) throw new CodexFeishuError(providerError)
  const route = parsed.data
  if ((route.wire_api && route.wire_api !== 'responses') || route.auth || route.aws || route.gateway_oauth || route.credential_file) throw new CodexFeishuError(providerError)
  const baseUrl = official ? config.openai_base_url || 'https://api.openai.com/v1' : route.base_url
  const endpoint = baseUrl ? URL.parse(baseUrl) : null
  if (!endpoint || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname))) throw new CodexFeishuError(providerError)
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/responses`
  for (const [key, value] of Object.entries(route.query_params ?? {})) endpoint.searchParams.set(key, value)
  const headers = new Headers(route.http_headers ?? {})
  const readEnv = (key: string) => env[process.platform === 'win32' ? key.toUpperCase() : key]
  for (const [header, variable] of Object.entries(route.env_http_headers ?? {})) {
    const value = readEnv(variable)
    if (!value) throw new CodexFeishuError(providerError)
    headers.set(header, value)
  }
  const keyName = route.env_key || (official ? 'OPENAI_API_KEY' : null)
  const token = keyName ? readEnv(keyName) : route.experimental_bearer_token
  if (token) headers.set('authorization', `Bearer ${token}`)
  if ((keyName || route.requires_openai_auth || official) && !headers.has('authorization')) throw new CodexFeishuError(providerError)
  headers.set('content-type', 'application/json')
  headers.set('accept-encoding', 'identity')
  const response = await integrationFetch(endpoint, { method: 'POST', headers, signal, body: JSON.stringify({
    model, instructions: system, input: user, tools: [], tool_choice: 'none', store: false, max_output_tokens: 1800
  }) }).catch(() => { throw new CodexFeishuError('Codex 的模型服务未响应，请检查该执行引擎的连接。') })
  if (!response.ok) throw new CodexFeishuError(`Codex 的模型服务未接受文字请求（HTTP ${response.status}）。`)
  const output = z.object({ status: z.literal('completed'), output: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('reasoning') }),
    z.object({ type: z.literal('message'), role: z.literal('assistant'), content: z.array(z.object({ type: z.literal('output_text'), text: z.string() })) })
  ])) }).safeParse(await response.json().catch(() => null))
  const text = output.success ? output.data.output.flatMap(item => item.type === 'message' ? item.content.map(part => part.text) : []).join('').trim() : ''
  if (!text) throw new CodexFeishuError('Codex 没有返回完整的文字答复。')
  return text
}
