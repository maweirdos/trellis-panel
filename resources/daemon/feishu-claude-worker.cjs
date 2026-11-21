'use strict'

const { execFile } = require('node:child_process')
const { isAbsolute } = require('node:path')
const { pathToFileURL } = require('node:url')

const MAX_INPUT = 512 * 1024
const MAX_OUTPUT = 512 * 1024

function unavailable(message) {
  return { ok: false, kind: 'unavailable', message }
}

function unknown(message) {
  return { ok: false, kind: 'unknown', message }
}

function execute(executable, args, input, timeout) {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, {
      cwd: process.cwd(), env: process.env, encoding: 'utf8', windowsHide: true,
      maxBuffer: MAX_OUTPUT, timeout
    }, (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin?.once('error', () => child.kill())
    child.stdin?.end(input)
  })
}

async function run(request) {
  if (!request || request.version !== 1 || typeof request.executable !== 'string' || !isAbsolute(request.executable) ||
      typeof request.sdk !== 'string' || !isAbsolute(request.sdk) || typeof request.system !== 'string' ||
      request.system.length > 16000 || typeof request.user !== 'string' || request.user.length > 100000 ||
      request.model !== undefined && (typeof request.model !== 'string' || request.model.length > 512)) {
    return unavailable('Claude 文字运行配置无效，请检查执行引擎设置。')
  }
  let sdk
  try { sdk = await import(pathToFileURL(request.sdk).href) }
  catch { return unavailable('无法读取所选 Claude 执行引擎，请重新安装该引擎。') }
  if (typeof sdk.resolveSettings !== 'function') {
    return unavailable('所选 Claude 执行引擎缺少安全配置检查，请更新该引擎。')
  }
  try {
    const settings = await sdk.resolveSettings({ settingSources: ['user'], cwd: process.cwd() })
    if (!settings || !Array.isArray(settings.sources) || !settings.effective ||
        settings.effective.policyHelper || settings.effective.apiKeyHelper ||
        settings.sources.some(source => source?.settings?.policyHelper || source?.settings?.apiKeyHelper)) {
      return unavailable('当前 Claude 配置使用外部认证或策略命令，飞书文字接入暂不可用。')
    }
    const environment = { ...settings.effective.env, ...process.env }
    if (!environment.ANTHROPIC_API_KEY ||
        ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
          'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
          .some(name => environment[name] && environment[name] !== '0' && environment[name] !== 'false')) {
      return unavailable('当前 Claude 认证方式不支持飞书的无工具模式，请在 Crux 检查 Claude 的认证配置。')
    }
  } catch { return unavailable('无法核对 Claude 的安全配置，飞书文字接入暂不可用。') }
  let version
  try { version = await execute(request.executable, ['--version'], '', 10000) }
  catch { return unavailable('无法启动所选 Claude 执行引擎，请在 Crux 检查引擎状态。') }
  const parsed = /^(\d+)\.(\d+)\.(\d+)\b/.exec(version.trim())
  if (!parsed || Number(parsed[1]) !== 2 ||
      Number(parsed[2]) < 1 || Number(parsed[2]) === 1 && Number(parsed[3]) < 286) {
    return unavailable('所选 Claude 版本不支持所需的文字隔离模式，请更新执行引擎。')
  }
  const args = [
    '--print', '--output-format', 'json', '--bare', '--tools', '',
    '--disallowedTools', '*', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--setting-sources', 'user', '--settings', '{"disableAllHooks":true,"apiKeyHelper":""}',
    '--system-prompt', request.system,
    ...(request.model ? ['--model', request.model] : [])
  ]
  let output
  try { output = await execute(request.executable, args, request.user, 45000) }
  catch { return unknown('Claude 没有返回可确认的答复，请在 Crux 检查运行时和模型状态。') }
  try {
    const result = JSON.parse(output)
    if (result?.type !== 'result' || result.subtype !== 'success' || result.is_error !== false ||
        typeof result.result !== 'string' || !result.result.trim() || result.result.length > 48000) {
      return unknown('Claude 没有返回可确认的答复，请在 Crux 检查运行时和模型状态。')
    }
    return { ok: true, text: result.result.trim() }
  } catch { return unknown('Claude 返回的答复无法核验，请在 Crux 检查运行时状态。') }
}

async function main() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > MAX_INPUT) return unavailable('飞书消息超过 Claude 文字接入的长度限制。')
    chunks.push(chunk)
  }
  try { return await run(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
  catch { return unavailable('Claude 文字接入暂不可用，请检查执行引擎设置。') }
}

void main().then(
  result => process.stdout.write(JSON.stringify(result)),
  () => process.stdout.write(JSON.stringify(unavailable('Claude 文字接入暂不可用，请检查执行引擎设置。')))
)
