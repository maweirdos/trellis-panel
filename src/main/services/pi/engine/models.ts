import { InMemoryCredentialStore, type Api, type FetchFunction, type Model, type Provider } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { PiInitialize, PiModel } from '../protocol'

const proxyDispatchers = new WeakMap<ModelRuntime, ProxyAgent>()

export async function disposeModels(runtime: ModelRuntime | undefined): Promise<void> {
  if (!runtime) return
  const dispatcher = proxyDispatchers.get(runtime)
  proxyDispatchers.delete(runtime)
  await dispatcher?.close()
}

function modelApi(api: PiModel['api']): Api {
  if (api === 'anthropic') return 'anthropic-messages'
  if (api === 'response') return 'openai-responses'
  return 'openai-completions'
}

function configuredFetch(endpoint: string | undefined, dispatcher: ProxyAgent | undefined): FetchFunction | undefined {
  if (!endpoint && !dispatcher) return undefined
  return (resource, options) => {
    // Normalize the platform Request first: Node's bundled undici Request and the
    // project's undici Request are different instances. Pass standard fields across.
    const request = new Request(resource, options)
    return undiciFetch(endpoint ?? request.url, {
      method: request.method, headers: [...request.headers], body: request.body, signal: request.signal,
      redirect: request.redirect, cache: request.cache, credentials: request.credentials,
      integrity: request.integrity, keepalive: request.keepalive, mode: request.mode,
      referrer: request.referrer, referrerPolicy: request.referrerPolicy, duplex: 'half', dispatcher
    })
  }
}

export async function createModels(input: PiInitialize): Promise<ModelRuntime> {
  const credentials = new InMemoryCredentialStore()
  const groups = new Map<string, PiModel[]>()
  const selections = new Set<string>()
  for (const model of input.models) {
    if (selections.has(model.selectionId)) throw new Error('Duplicate Pi model selection ID')
    selections.add(model.selectionId)
    const group = groups.get(model.providerId) ?? []
    if (group.some(item => item.modelId === model.modelId)) throw new Error('Duplicate Pi provider/model ID')
    if (group.some(item => item.apiKey !== model.apiKey)) throw new Error('A Pi provider must use one explicit credential')
    group.push(model)
    groups.set(model.providerId, group)
  }
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false })
  const dispatcher = input.proxy ? new ProxyAgent(input.proxy.url) : undefined
  if (dispatcher) proxyDispatchers.set(runtime, dispatcher)
  // ModelRuntime ships a builtin catalog. Mask it through the public provider API before any
  // availability refresh can consult an ambient provider's env/files or offer an unselected model.
  for (const builtin of runtime.getProviders()) {
    const unavailable = () => { throw new Error('Provider is not configured by the host') }
    runtime.registerNativeProvider({ id: builtin.id, name: builtin.name, getModels: () => [],
      auth: { apiKey: { name: 'Disabled by host', check: async () => undefined, resolve: async () => undefined } },
      stream: unavailable, streamSimple: unavailable })
  }
  for (const [id, definitions] of groups) {
    const first = definitions[0]
    if (!first) throw new Error('Empty Pi provider')
    // A nonempty explicit key also prevents low-level clients falling back to ambient auth for keyless local servers.
    const key = first.apiKey || 'pi-explicit-keyless-provider'
    await credentials.modify(id, async () => ({ type: 'api_key', key }))
    const models: Model<Api>[] = definitions.map(item => ({
      id: item.modelId, name: item.label, provider: id, api: modelApi(item.api), baseUrl: item.baseUrl,
      reasoning: item.reasoning, input: ['text', 'image'], contextWindow: item.contextWindow, maxTokens: item.maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }))
    const fetches = new Map(definitions.map(item => [item.modelId, configuredFetch(item.api === 'ollama' ? undefined : item.endpoint, dispatcher)]))
    const apiFor = (model: Model<Api>) => model.api === 'anthropic-messages' ? anthropicMessagesApi()
      : model.api === 'openai-responses' ? openAIResponsesApi() : openAICompletionsApi()
    const provider: Provider = {
      id, name: id, getModels: () => models,
      auth: { apiKey: {
        name: 'Explicit host credential',
        check: async () => ({ type: 'api_key', source: 'host configuration' }),
        resolve: async () => ({ auth: { apiKey: key }, source: 'host configuration' })
      } },
      stream: (model, context, options) => {
        const fetch = fetches.get(model.id)
        return apiFor(model).stream(model, context, { ...options, apiKey: key, ...(fetch ? { fetch } : {}) })
      },
      streamSimple: (model, context, options) => {
        const fetch = fetches.get(model.id)
        return apiFor(model).streamSimple(model, context, { ...options, apiKey: key, ...(fetch ? { fetch } : {}) })
      }
    }
    runtime.registerNativeProvider(provider)
  }
  await runtime.refresh({ allowNetwork: false, providers: [...groups.keys()] })
  return runtime
}

export function selectedModel(input: PiInitialize, runtime: ModelRuntime, selectionId: string): Model<Api> {
  const definition = input.models.find(item => item.selectionId === selectionId)
  const model = definition && runtime.getModel(definition.providerId, definition.modelId)
  if (!model) throw new Error('Pi model selection is not in the explicit configured models')
  return model
}

/** The validated native branch owns restored selection; only explicit recovery can replace it. */
export function initialModelSelection(input: PiInitialize, saved: { provider: string; modelId: string } | null): string {
  const selectionId = input.sessionFile
    ? input.recoveryModelId ?? input.models.find(model => model.providerId === saved?.provider && model.modelId === saved.modelId)?.selectionId
    : input.modelId
  if (!selectionId || !input.models.some(model => model.selectionId === selectionId)) throw new Error('PI_MODEL_UNAVAILABLE: 保存的 Pi 模型已不可用；请显式选择原会话候选模型后恢复')
  return selectionId
}
