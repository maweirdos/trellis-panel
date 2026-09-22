/**
 * 统一代理冒烟（roadmap #10 / TPD-015）：
 * 本地 HTTP 转发代理（absolute-form GET/POST）+ 目标 OpenAI 兼容服务：
 *   ① 代理启用：aiChatStream / fetchModelsFromProvider 的请求出现在代理日志且业务成功；
 *   ② 代理禁用：目标服务直接收到请求、代理零请求。
 * models.dev 拉取与 chat 共用 withProxy 入口，路径覆盖见注释。
 * 运行：node scripts/smoke/proxy.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import { createServer, request as httpRequest } from 'http'

const TARGET_PORT = 39701
const PROXY_PORT = 39702
const workDir = mkdtempSync(join(tmpdir(), 'tpanel-proxy-smoke-'))
process.env.TPAP_SMOKE_DIR = workDir

/* ---------------- 目标服务（OpenAI 兼容） ---------------- */

const targetHits = []
const target = createServer((req, res) => {
  targetHits.push(req.url)
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'proxy-model' }] }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '经代理' } }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((r) => target.listen(TARGET_PORT, '127.0.0.1', r))

/* ---------------- 转发代理（absolute-form） ---------------- */

const proxyHits = []
const proxy = createServer((req, res) => {
  proxyHits.push(req.url)
  const targetUrl = new URL(req.url ?? '/', `http://127.0.0.1:${TARGET_PORT}`)
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const fwd = httpRequest(
      { host: '127.0.0.1', port: TARGET_PORT, path: targetUrl.pathname + targetUrl.search, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${TARGET_PORT}` } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      }
    )
    fwd.on('error', () => {
      res.writeHead(502)
      res.end()
    })
    if (chunks.length) fwd.write(Buffer.concat(chunks))
    fwd.end()
  })
})
// undici v6 ProxyAgent 对 http 目标也走 CONNECT 隧道（v8 才改 absolute-form），
// 冒烟代理必须支持 CONNECT：建立到目标的 TCP 并双向管道
import { connect as tcpConnect } from 'net'
proxy.on('connect', (req, clientSocket, head) => {
  proxyHits.push(`CONNECT ${req.url}`)
  const targetUrl2 = new URL(`http://${req.url}`)
  const upstream = tcpConnect(Number(targetUrl2.port || 80), targetUrl2.hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  upstream.on('error', () => {
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  clientSocket.on('error', () => upstream.destroy())
})
await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r))

/* ---------------- settings + bundle ---------------- */

writeFileSync(
  join(workDir, 'settings.json'),
  JSON.stringify({
    ai: {
      enabled: true,
      baseUrl: `http://127.0.0.1:${TARGET_PORT}/v1`,
      model: 'proxy-model',
      temperature: 0.3,
      activeProviderId: 'mock',
      providers: [
        {
          id: 'mock',
          name: 'Mock',
          enabled: true,
          baseUrl: `http://127.0.0.1:${TARGET_PORT}/v1`,
          apiFormat: 'openai',
          apiKey: 'sk-mock',
          models: [{ id: 'proxy-model', name: 'proxy-model', enabled: true }]
        }
      ]
    },
    proxy: { enabled: false, url: '' }
  }),
  'utf-8'
)

const requireBanner = "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
const alias = `${join(process.cwd(), 'scripts', 'smoke', 'mock-electron.mjs').replace(/\\/g, '/')}`
// packages=external 时 undici 从项目 node_modules 解析 → bundle 必须落在项目内
const bundleDir = join(process.cwd(), '.smoke-tmp')
mkdirSync(bundleDir, { recursive: true })
const build = (entry, outfile) =>
  execFileSync(
    process.execPath,
    ['node_modules/esbuild/bin/esbuild', entry, '--bundle', '--format=esm', '--platform=node', '--packages=external', `--banner:js=${requireBanner}`, `--alias:electron=${alias}`, `--outfile=${join(bundleDir, outfile)}`],
    { stdio: 'inherit' }
  )

const aiBundle = 'ai-bundle.mjs'
build('src/main/services/ai.ts', aiBundle)
const ai = await import(pathToFileURL(join(bundleDir, aiBundle)).href)

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
  if (!cond) failures += 1
}

/* ② 先验证禁用态：直连，代理零请求 */
const direct = await ai.aiChatStream(
  { baseUrl: `http://127.0.0.1:${TARGET_PORT}/v1`, apiFormat: 'openai', model: 'proxy-model', apiKey: 'sk-mock' },
  [{ role: 'user', content: 'hi' }],
  { onDelta: () => {} }
)
check('代理禁用时直连成功', direct.ok && direct.content === '经代理', JSON.stringify(direct))
check('代理禁用时代理零请求', proxyHits.length === 0, JSON.stringify(proxyHits))

/* ① 启用代理：请求必须经代理转发 */
writeFileSync(join(workDir, 'settings.json'), JSON.stringify({
  ai: {
    enabled: true,
    baseUrl: `http://127.0.0.1:${TARGET_PORT}/v1`,
    model: 'proxy-model',
    temperature: 0.3,
    activeProviderId: 'mock',
    providers: [{ id: 'mock', name: 'Mock', enabled: true, baseUrl: `http://127.0.0.1:${TARGET_PORT}/v1`, apiFormat: 'openai', apiKey: 'sk-mock', models: [{ id: 'proxy-model', name: 'proxy-model', enabled: true }] }]
  },
  proxy: { enabled: true, url: `http://127.0.0.1:${PROXY_PORT}` }
}), 'utf-8')
// settings 缓存重置：重新 bundle（模块级 settings 缓存随新实例刷新）
const aiBundle2 = 'ai-bundle2.mjs'
build('src/main/services/ai.ts', aiBundle2)
const ai2 = await import(pathToFileURL(join(bundleDir, aiBundle2)).href)

const proxied = await ai2.aiChatStream(
  { baseUrl: `http://127.0.0.1:${TARGET_PORT}/v1`, apiFormat: 'openai', model: 'proxy-model', apiKey: 'sk-mock' },
  [{ role: 'user', content: 'hi' }],
  { onDelta: () => {} }
)
check('代理启用时流式请求成功', proxied.ok && proxied.content === '经代理', JSON.stringify(proxied))
check('请求确实经过代理转发（v8 absolute-form / v6 CONNECT 双形态兼容）', proxyHits.length > 0 && proxyHits.some((u) => String(u ?? '').includes('CONNECT') || String(u ?? '').includes('/chat/completions')), JSON.stringify(proxyHits))

const discovery = await ai2.fetchModelsFromProvider({ baseUrl: `http://127.0.0.1:${TARGET_PORT}/v1`, apiFormat: 'openai', apiKey: 'sk-mock' })
check('模型探测同样经代理', discovery.ok && discovery.models?.length === 1 && proxyHits.length >= 2, JSON.stringify(proxyHits))

/* 收尾 */
proxy.close()
target.close()
rmSync(workDir, { recursive: true, force: true })
rmSync(bundleDir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`proxy smoke: ${failures} 项失败`)
  process.exit(1)
}
console.log('proxy smoke: 全部通过')
