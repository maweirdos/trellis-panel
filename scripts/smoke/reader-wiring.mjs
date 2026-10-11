/**
 * 三入口接线冒烟（S0 G2 第三片，implement.md G2 收尾）：node scripts/smoke/reader-wiring.mjs
 * 覆盖——
 *   1) 变更信号桥（change-bridge）：定向性（无关文档零通知）、knownRevision 竞态闭合、
 *      引用计数、settle 合并、读不到时 revision=null、项目清空、scope/越界请求级失败；
 *   2) reader 切片（真实 zustand 组合）：会话建立/外部变化标记/阅读新版/关闭收口/清空；
 *   3) 会话集线器（hub）：按 canonicalPath 定向分发、注销幂等；
 *   4) Esc 层级（纯注册表）：优先级只消费最上层一层、焦点归还（元素仍挂载时）；
 *   5) 锚点恢复（纯核心）：锚点存活/消失回退最近存活章节/无存活锚点截断；
 *   6) 相对路径折算（渲染端纯函数）：根内/根外/反斜杠。
 * 主进程服务与渲染端切片按既有冒烟约定先 esbuild 打包（无扩展名相对导入）。
 */
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'
import { realpathSync } from 'fs'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'

const abs = (p) => join(process.cwd(), p).replace(/\\/g, '/')
const workDir = mkdtempSync(join(tmpdir(), 'tpanel-reader-wiring-'))
const requireBanner = "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"

/* ---------------- 打包：主服务 + 渲染端纯逻辑 + reader 切片（真实 zustand） ---------------- */

const entry = join(workDir, 'entry.ts')
writeFileSync(
  entry,
  [
    `export * from '${abs('src/main/services/documents/index.ts')}'`,
    `export * from '${abs('src/renderer/src/reader/reader-paths.ts')}'`,
    `export * from '${abs('src/renderer/src/reader/scroll-restore.ts')}'`,
    `export * from '${abs('src/renderer/src/reader/document-session-hub.ts')}'`,
    `export * from '${abs('src/renderer/src/utils/esc-layer.ts')}'`,
    `import { create } from 'zustand'`,
    `import { readerSlice } from '${abs('src/renderer/src/store/slices/reader.ts')}'`,
    `export const makeReaderStore = () => create()((set, get, store) => ({ ...readerSlice(set, get, store) }))`
  ].join('\n'),
  'utf-8'
)
const bundle = join(workDir, 'bundle.mjs')
execFileSync(
  process.execPath,
  [
    join('node_modules', 'esbuild', 'bin', 'esbuild'),
    entry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--banner:js=${requireBanner}`,
    // entry 在临时目录，node_modules 解析走绝对别名（与 ipc-registry 的 electron 别名同一手法）；
    // 别名指到包目录以覆盖 zustand/vanilla 等子路径
    `--alias:zustand=${abs('node_modules/zustand')}`,
    `--outfile=${bundle}`
  ],
  { stdio: 'inherit' }
)

// settle 阈值压到 20ms（生产 300ms；与 DIFF_WORKER_FILE_ENV 同一注入模式）
process.env.TRELLIS_READER_SETTLE_MS = '20'

const m = await import(pathToFileURL(bundle).href)
const {
  watchReaderDocument,
  unwatchReaderDocument,
  clearReaderDocuments,
  routeReaderDocumentChange,
  onReaderDocumentChanged,
  computeRevision,
  makeReaderStore,
  registerDocumentSession,
  receiveDocumentChanged,
  documentSessionCount,
  activateEscLayer,
  dispatchEscKey,
  escLayerCount,
  resolveScrollRestore,
  relativePathUnderRoot
} = m

let failures = 0
let assertions = 0
const check = (name, cond, extra = '') => {
  assertions += 1
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
  if (!cond) failures += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SCOPE = { workspaceId: 'ws-wiring', taskRef: 'demo' }

/* ---------------- 事件收集 ---------------- */

const events = []
const offEvents = onReaderDocumentChanged((e) => events.push(e))

const rootReal = realpathSync(mkdtempSync(join(tmpdir(), 'wiring-root-')))
const relOf = (p) => {
  const rel = resolve(p).slice(rootReal.length + 1)
  return sep === '\\' ? rel.split(sep).join('/') : rel
}

try {
  mkdirSync(join(rootReal, '.trellis', 'tasks', 'demo'), { recursive: true })
  const docA = join(rootReal, '.trellis', 'tasks', 'demo', 'prd.md')
  const docB = join(rootReal, '.trellis', 'tasks', 'demo', 'design.md')
  writeFileSync(docA, '# v1\n', 'utf-8')
  writeFileSync(docB, '# other\n', 'utf-8')
  const relA = relOf(docA)
  const relB = relOf(docB)

  /* ---------------- 1. 变更信号桥 ---------------- */

  // 1a. knownRevision 竞态闭合：注册时磁盘版本与调用方已知不同 → 立即补发
  const w1 = watchReaderDocument(rootReal, SCOPE, { relativePath: relA, knownRevision: 'stale-rev' })
  check('watch 成功并返回 canonicalPath', w1.ok === true && typeof w1.canonicalPath === 'string' && w1.canonicalPath.length > 0)
  check(
    'knownRevision 竞态闭合：注册即补发一条定向事件（磁盘版 ≠ 已知版）',
    events.length === 1 && events[0].canonicalPath === w1.canonicalPath && events[0].revision === computeRevision(Buffer.from('# v1\n', 'utf-8'))
  )
  check('事件携带归一化 relativePath', events[0].relativePath === relA)
  events.length = 0

  // 1b. 定向性：无关文档变化零通知；settle 合并连续写入
  writeFileSync(docA, '# v2 first\n', 'utf-8')
  routeReaderDocumentChange(docA)
  await sleep(5)
  writeFileSync(docA, '# v2 final\n', 'utf-8')
  routeReaderDocumentChange(docA)
  routeReaderDocumentChange(docB) // 未注册：不应产生任何事件
  await sleep(80)
  check('settle 合并连续写入为一次通知', events.length === 1, `events=${JSON.stringify(events)}`)
  check(
    '通知携带最终内容摘要（sha256 前 16 hex）',
    events[0]?.revision === computeRevision(Buffer.from('# v2 final\n', 'utf-8'))
  )
  check('无关文档（docB）零通知', events.every((e) => e.canonicalPath === w1.canonicalPath))
  events.length = 0

  // 1c. 同版信号抑制在主进程侧不重发（渲染端消费时清提示）：文件未再变 → route 不发
  routeReaderDocumentChange(docA)
  await sleep(80)
  check('文件未变化仍会通知（digest 相同，由渲染端状态机清提示）', events.length === 1 && events[0].revision === computeRevision(Buffer.from('# v2 final\n', 'utf-8')))
  events.length = 0

  // 1d. 引用计数：同路径两个会话，解除一个仍通知，全部解除后停发
  const w2 = watchReaderDocument(rootReal, { workspaceId: 'ws-other' }, { relativePath: relA, knownRevision: null })
  check('第二个会话注册同一路径（refs=2）', w2.ok === true && w2.canonicalPath === w1.canonicalPath)
  unwatchReaderDocument(w1.canonicalPath)
  writeFileSync(docA, '# v3\n', 'utf-8')
  routeReaderDocumentChange(docA)
  await sleep(80)
  check('引用计数未归零仍定向通知', events.length === 1 && events[0].revision === computeRevision(Buffer.from('# v3\n', 'utf-8')))
  events.length = 0
  unwatchReaderDocument(w2.canonicalPath)
  writeFileSync(docA, '# v4\n', 'utf-8')
  routeReaderDocumentChange(docA)
  await sleep(80)
  check('引用计数归零后停发（解除监听收口）', events.length === 0)
  // 重复 unwatch 幂等的的行为学证明：再次解除后重新 watch 仍正常工作
  unwatchReaderDocument(w2.canonicalPath)
  const w3 = watchReaderDocument(rootReal, SCOPE, { relativePath: relA, knownRevision: null })
  writeFileSync(docA, '# v5\n', 'utf-8')
  routeReaderDocumentChange(docA)
  await sleep(80)
  check('重复 unwatch 后重新 watch 正常（幂等未破坏注册表）', w3.ok === true && events.length === 1 && events[0].revision === computeRevision(Buffer.from('# v5\n', 'utf-8')))
  unwatchReaderDocument(w3.canonicalPath)
  events.length = 0

  // 1e. 读不到（文件被删除）→ revision=null 事件（渲染端重读取得诚实诊断）
  const wMiss = watchReaderDocument(rootReal, SCOPE, { relativePath: relB, knownRevision: null })
  unlinkSync(docB)
  routeReaderDocumentChange(docB)
  await sleep(80)
  check('文件被删除：通知 revision=null（不伪装成版本）', events.length === 1 && events[0].canonicalPath === wMiss.canonicalPath && events[0].revision === null)
  events.length = 0

  // 1f. 项目清空：clearReaderDocuments 后不再通知
  clearReaderDocuments()
  writeFileSync(docA, '# v5\n', 'utf-8')
  routeReaderDocumentChange(docA)
  await sleep(80)
  check('clearReaderDocuments 清空全部监听（项目切换收口）', events.length === 0)

  // 1g. 请求级失败：scope 非法 / 路径越界
  const badScope = watchReaderDocument(rootReal, { taskRef: 'x' }, { relativePath: relA, knownRevision: null })
  check('scope 非法 → E_INVALID_ARG', badScope.ok === false && badScope.code === 'E_INVALID_ARG')
  const badPath = watchReaderDocument(rootReal, SCOPE, { relativePath: '../../outside.md', knownRevision: null })
  check('路径越界（..逃逸）→ E_INVALID_ARG', badPath.ok === false && badPath.code === 'E_INVALID_ARG')
  const badInput = watchReaderDocument(rootReal, SCOPE, { relativePath: '', knownRevision: 'x' })
  check('relativePath 为空 → E_INVALID_ARG', badInput.ok === false && badInput.code === 'E_INVALID_ARG')

  /* ---------------- 2. reader 切片（真实 zustand 组合） ---------------- */

  const store = makeReaderStore()
  const v1 = { revision: 'r1', text: '# v1\n' }
  const v2 = { revision: 'r2', text: '# v2\n' }
  const keyA = 'ws-wiring::demo::.trellis/tasks/demo/prd.md'

  store.getState().readerOpenSession(keyA, v1)
  check('切片组合：readerOpenSession 建立会话', store.getState().readingSessions[keyA]?.base === v1 && store.getState().readingSessions[keyA]?.displayed === v1)
  store.getState().readerExternalChange(keyA, v2)
  check('切片组合：外部变化只标记 latest', store.getState().readingSessions[keyA]?.latest === v2 && store.getState().readingSessions[keyA]?.displayed === v1)
  store.getState().readerReadNewVersion(keyA)
  check('切片组合：阅读新版替换 displayed 不改基线', store.getState().readingSessions[keyA]?.displayed === v2 && store.getState().readingSessions[keyA]?.base === v1)
  store.getState().readerCloseSession(keyA)
  check('切片组合：readerCloseSession 移除会话键（快照丢弃）', !(keyA in store.getState().readingSessions))
  check('切片组合：对不存在键 close 为 no-op', (store.getState().readerCloseSession('missing::key'), Object.keys(store.getState().readingSessions).length === 0))
  store.getState().readerOpenSession('k1', v1)
  store.getState().readerOpenSession('k2', v1)
  store.getState().readerClearAllSessions()
  check('切片组合：readerClearAllSessions 清空全部会话（项目切换）', Object.keys(store.getState().readingSessions).length === 0)

  /* ---------------- 3. 会话集线器（hub 定向分发） ---------------- */

  const got = []
  const off1 = registerDocumentSession('k1', '/canon/a.md', (e) => got.push(['k1', e.revision]))
  const off2 = registerDocumentSession('k2', '/canon/a.md', (e) => got.push(['k2', e.revision]))
  const off3 = registerDocumentSession('k3', '/canon/b.md', (e) => got.push(['k3', e.revision]))
  receiveDocumentChanged({ canonicalPath: '/canon/a.md', relativePath: 'a.md', revision: 'rev-9' })
  check(
    'hub 按 canonicalPath 定向分发（同路径两会话都收到，其他路径零分发）',
    got.length === 2 && got[0][0] === 'k1' && got[1][0] === 'k2' && got.every(([k]) => k !== 'k3') && got[0][1] === 'rev-9'
  )
  got.length = 0
  off1()
  off1() // 幂等
  receiveDocumentChanged({ canonicalPath: '/canon/a.md', relativePath: 'a.md', revision: 'rev-10' })
  check('hub 注销幂等：注销一个键不影响同路径其他键', got.length === 1 && got[0][0] === 'k2')
  check('hub 未匹配路径零分发', (receiveDocumentChanged({ canonicalPath: '/canon/none.md', relativePath: 'x', revision: 'r' }), got.length === 1))
  off2()
  off3()
  check('hub 全部注销后注册表清空', documentSessionCount() === 0)

  /* ---------------- 4. Esc 层级（聚合，不叠罗汉） ---------------- */

  const closed = []
  const focusCalls = []
  const focusEl = { isConnected: true, focus: () => focusCalls.push(1) }
  const detachedEl = { isConnected: false, focus: () => focusCalls.push(99) }
  const offPreview = activateEscLayer({ id: 'preview-x', kind: 'preview', onClose: () => closed.push('preview') })
  const offOverlay = activateEscLayer({ id: 'overlay-x', kind: 'overlay', onClose: () => closed.push('overlay'), returnFocusRef: { current: focusEl } })
  activateEscLayer({ id: 'modal-x', kind: 'modal', onClose: () => closed.push('modal'), returnFocusRef: { current: detachedEl } })
  check('三层登记在册', escLayerCount() === 3)
  dispatchEscKey()
  check('第一次 Esc 只关最上层（modal），且已卸载焦点目标安全跳过', closed.length === 1 && closed[0] === 'modal' && focusCalls.length === 0)
  dispatchEscKey()
  check('第二次 Esc 关下一层（overlay）并归还焦点到仍挂载的触发处', closed.length === 2 && closed[1] === 'overlay' && focusCalls.length === 1)
  dispatchEscKey()
  check('第三次 Esc 关预览层（逐层退出，一次 Esc 不连关）', closed.length === 3 && closed[2] === 'preview')
  check('无层时 Esc 不再消费', dispatchEscKey() === false)
  const offTmp = activateEscLayer({ id: 'tmp', kind: 'preview', onClose: () => closed.push('tmp') })
  offTmp()
  check('手动注销后不再消费', dispatchEscKey() === false && closed.length === 3)
  void offPreview
  void offOverlay

  /* ---------------- 5. 锚点恢复（纯核心） ---------------- */

  const oldMd = '# A\n\ntext\n\n## B\n\nb-text\n\n## C\n\nc-text\n'
  const newKeep = '# A\n\ntext\n\n## B\n\nb-changed\n\n## C\n\nc-text\n'
  const plan1 = resolveScrollRestore({
    captured: { anchorId: 'b', offsetPx: 120, scrollTopPx: 480 },
    oldText: oldMd,
    newText: newKeep
  })
  check('锚点存活：原锚点 + 原段内偏移，不提示', plan1.targetAnchorId === 'b' && plan1.offsetPx === 120 && plan1.fallbackUsed === false && plan1.absolutePx === null)

  const newNoB = '# A\n\ntext\n\n## C2\n\nc-text\n'
  const plan2 = resolveScrollRestore({
    captured: { anchorId: 'b', offsetPx: 60, scrollTopPx: 300 },
    oldText: oldMd,
    newText: newNoB
  })
  check('锚点消失：回退到之前最近的存活章节（a）并提示', plan2.targetAnchorId === 'a' && plan2.fallbackUsed === true)

  const plan3 = resolveScrollRestore({
    captured: { anchorId: 'a', offsetPx: 30, scrollTopPx: 100 },
    oldText: oldMd,
    newText: '# Z\n\nz\n\n## B\n\nb\n'
  })
  check('锚点消失且无前驱：取其后最近的存活章节（b）并提示', plan3.targetAnchorId === 'b' && plan3.fallbackUsed === true)

  const plan4 = resolveScrollRestore({
    captured: { anchorId: 'b', offsetPx: 60, scrollTopPx: 500 },
    oldText: oldMd,
    newText: 'no headings at all\n'
  })
  check('无任何存活锚点：截断恢复旧 scrollTop 并提示', plan4.targetAnchorId === null && plan4.absolutePx === 500 && plan4.fallbackUsed === true)

  const plan5 = resolveScrollRestore({
    captured: { anchorId: null, offsetPx: 0, scrollTopPx: 220 },
    oldText: oldMd,
    newText: newKeep
  })
  check('捕获时不在任何章节：直接按 scrollTop 恢复，不提示', plan5.targetAnchorId === null && plan5.absolutePx === 220 && plan5.fallbackUsed === false)

  /* ---------------- 6. 相对路径折算（渲染端） ---------------- */

  const root = 'D:/work/proj'
  check(
    '根内绝对路径折算（含反斜杠归一）',
    relativePathUnderRoot(root, 'D:\\work\\proj\\.trellis\\tasks\\demo\\prd.md') === '.trellis/tasks/demo/prd.md' &&
      relativePathUnderRoot(root, 'D:/work/proj/a.md') === 'a.md'
  )
  check('根外路径返回 null（降级信号）', relativePathUnderRoot(root, 'E:/other/x.md') === null && relativePathUnderRoot(root, 'D:/work/other/x.md') === null && relativePathUnderRoot(root, 'D:/work/proj') === null)
  check('空根返回 null', relativePathUnderRoot('', 'D:/x.md') === null)
} finally {
  offEvents()
  clearReaderDocuments()
  rmSync(workDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`三入口接线冒烟：${failures} 项失败（共 ${assertions} 项断言）`)
  process.exit(1)
}
console.log(`三入口接线冒烟：全部通过 ✓（${assertions} 项断言）`)
