import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { AcpAgentProfile, ModelItem } from '../../../shared/types'
import { getSettings } from '../store'
import { decryptKeyOf, resolveEndpoint } from '../ai'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { piModelSchema, type PiModel } from './protocol'
import { readBoundedBytes } from '../../daemon/files'

function contextWindow(model: ModelItem): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([km])?\s*$/i.exec(model.contextWindow ?? '')
  const value = match ? Number(match[1]) * (match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2] ? 1000 : 1) : 128_000
  return Number.isSafeInteger(value) && value >= 4096 ? value : 128_000
}
export function piConfiguredModels(): { models: PiModel[]; defaultModelId: string; revision: string; proxy?: { url: string } } {
  const settings = getSettings(), ai = settings.ai
  const proxy = settings.proxy?.enabled && settings.proxy.url ? { url: settings.proxy.url } : undefined
  const providers = ai.providers?.length ? ai.providers : ai.enabled && ai.model ? [{ id: 'default', name: '默认模型', enabled: true,
    baseUrl: ai.baseUrl, apiFormat: ai.apiFormat ?? 'openai', apiKey: ai.apiKey, apiKeyEncrypted: ai.apiKeyEncrypted,
    models: [{ id: ai.model, name: ai.model, enabled: true }] }] : []
  const models = providers.filter(provider => provider.enabled).flatMap(provider => provider.models.filter(model => model.enabled).map(model => {
    // Pi speaks Ollama's OpenAI-compatible /v1 API, including configurations
    // whose legacy UI URL names the native /api/chat endpoint.
    const resolvedEndpoint = resolveEndpoint(provider.baseUrl, provider.apiFormat)
    const endpoint = provider.apiFormat !== 'ollama' ? resolvedEndpoint : undefined
    let baseUrl = resolvedEndpoint.replace(/\/+$/, '')
    baseUrl = baseUrl.replace(/\/(?:chat\/completions|responses|messages)$/, '')
    if (provider.apiFormat === 'ollama') baseUrl = resolveEndpoint(provider.baseUrl, 'openai').replace(/\/chat\/completions$/, '').replace(/\/(?:api\/chat|api|v1)$/, '') + '/v1'
    if (provider.apiFormat === 'anthropic') baseUrl = baseUrl.replace(/\/v1$/, '')
    const size = contextWindow(model)
    return piModelSchema.parse({ selectionId: `${provider.id}:${model.id}`, providerId: `planner-${createHash('sha256').update(provider.id).digest('hex').slice(0,16)}`,
      label: `${provider.name} · ${model.name || model.id}`, api: provider.apiFormat, baseUrl, endpoint,
      apiKey: decryptKeyOf(provider.apiKey, provider.apiKeyEncrypted), modelId: model.id, contextWindow: size,
      maxTokens: Math.min(model.maxTokens ?? 8192, Math.floor(size / 2)), reasoning: true })
  }))
  if (!models.length) throw new Error('请先在设置 → AI 模型中启用一个供应商和模型，再创建 Pi 会话')
  const preferred = models.find(model => model.selectionId === `${ai.activeProviderId}:${ai.model}`)
    ?? models.find(model => model.selectionId.startsWith(`${ai.activeProviderId}:`)) ?? models[0]
  if (!preferred) throw new Error('没有可用的 Pi 模型配置')
  return { models, defaultModelId: preferred.selectionId, proxy, revision: createHash('sha256').update(JSON.stringify({ models, proxy })).digest('hex') }
}
const server = z.object({ type: z.enum(['stdio', 'http', 'streamable-http']).optional(), command: z.string().min(1).optional(),
  args: z.array(z.string()).max(64).optional(), cwd: z.string().optional(), env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().optional(), headers: z.record(z.string(), z.string()).optional(), timeout: z.number().positive().optional(), enabled: z.boolean().optional(),
  description: z.string().optional() }).strict().refine(value => Boolean(value.command) !== Boolean(value.url), 'MCP 需要单一 command 或 URL')
const configSchema = z.object({ mcpServers: z.record(z.string(), server) }).strict()
export function piProjectMcp(root: string, profile?: AcpAgentProfile): { servers: Array<{ name: string; config: Record<string, unknown> }>; revision: string } {
  const names = [...new Set(profile?.mcpServerNames ?? [])]
  if (!names.length) return { servers: [], revision: '' }
  const path = resolveAuthorizedDocumentPath(root, join('.pi', 'mcp.json'))
  if (!path.ok || !path.exists) throw new Error('选定的项目 MCP 配置 .pi/mcp.json 不存在或超出项目范围')
  const bytes = readBoundedBytes(path.canonicalPath, 256 * 1024)
  const parsed = configSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')))
  const servers = names.map(name => {
    if (name.replaceAll('-', '_') === 'trellis_knowledge') throw new Error('trellis_knowledge 为内置项目知识工具保留名称，请为自定义 MCP 使用其他名称')
    const value = parsed.mcpServers[name]
    if (!value || value.enabled === false) throw new Error(`选定的 MCP 未启用或不存在：${name}`)
    if (Object.values({ ...value.env, ...value.headers }).some(text => text.startsWith('!'))) throw new Error('Pi 项目 MCP 不执行配置中的 !命令；请使用显式环境变量或头字段')
    if (value.command && /[\r\n]/.test(value.command)) throw new Error('MCP command 必须是单个可执行文件')
    return { name, config: { ...value, exposure: 'direct' } }
  })
  return { servers, revision: createHash('sha256').update(bytes).digest('hex') }
}
