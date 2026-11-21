import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { FeishuOutput } from '../../../../shared/feishu-integration'
import type { aiChat } from '../../ai'
import { nativeResource, powershellPath } from '../../../daemon/native'
import { resolveAcpRuntimeLaunch } from '../../acp/setup'
import { piConfiguredModels } from '../../pi/models'
import { getSettings } from '../../store'
import { exactAssistantModel, sameAssistantModel } from './plan'

async function launch() {
  const selected = await resolveAcpRuntimeLaunch('pi')
  if (!('argv' in selected) || selected.config.launchKind !== 'sdk') throw new Error('当前设备未启用 Pi 运行环境。')
  const [node, engine] = selected.argv
  const entry = join(dirname(engine), 'text-completion.mjs')
  if (!existsSync(entry)) throw new Error('缺少 Pi 文字处理组件，请更新 Crux。')
  return { node, entry, name: selected.config.name }
}

export async function feishuRuntimes(): Promise<NonNullable<FeishuOutput<'snapshot'>['runtimes']>> {
  try {
    const { name } = await launch()
    return [{ id: 'pi', name, deviceName: hostname() || '本机' }]
  } catch { return [] }
}

export function piFeishuChat(providerId?: string | null, modelId?: string | null): typeof aiChat {
  return async (configuration, messages, options) => {
    try {
      const configured = piConfiguredModels()
      const selection = providerId && modelId ? `${providerId}:${modelId}` : configured.defaultModelId
      const model = configured.models.find(item => item.selectionId === selection && item.modelId === configuration.model)
      const [system, user] = messages
      if (!model || messages.length !== 2 || system.role !== 'system' || user.role !== 'user') return { ok: false }
      const { node, entry } = await launch()
      if (!sameAssistantModel(exactAssistantModel(getSettings().ai, providerId, modelId), configuration)) return { ok: false }
      const request = JSON.stringify({ model, proxy: configured.proxy, system: system.content, user: user.content,
        maxTokens: options?.maxTokens ?? 2000, temperature: options?.temperature })
      if (Buffer.byteLength(request) > 1024 * 1024) return { ok: false }
      const windows = process.platform === 'win32'
      const base64 = (text: string) => Buffer.from(text).toString('base64')
      const executable = windows ? powershellPath() : node
      const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        nativeResource('windows-pi-engine.ps1'), '-ExecutableBase64', base64(node), '-EntryBase64', base64(entry)] : [entry]
      const env: NodeJS.ProcessEnv = {}
      for (const name of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
        if (process.env[name]) env[name] = process.env[name]
      }
      const timeout = AbortSignal.timeout(50_000)
      const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      signal.throwIfAborted()
      const output = await new Promise<string>((resolve, reject) => {
        const child = execFile(executable, args, { cwd: dirname(entry), env, signal, windowsHide: true, maxBuffer: 512 * 1024, encoding: 'utf8' },
          (error, stdout) => error ? reject(new Error('Pi 文字处理未完成。')) : resolve(stdout))
        child.stdin?.once('error', () => child.kill())
        child.stdin?.end(request)
      })
      const { text } = z.object({ text: z.string().min(1).max(48_000) }).strict().parse(JSON.parse(output))
      return { ok: true, content: text, model: model.modelId }
    } catch { return { ok: false, error: 'Pi 文字处理未完成，请检查当前运行环境和模型。' } }
  }
}
