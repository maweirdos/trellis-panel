/**
 * 任务读取器冒烟（S0 G2 地基，implement.md §8 计划入口 node scripts/smoke/task-reader.mjs）：
 * 用临时夹具断言——task.json 未知字段保留、jsonl 坏行真实行号（含空行偏移）、
 * revision 随内容变化、坏 JSON/半写容错、5MiB 限额、路径越界/软链接逃逸拒绝、
 * .panel/runtime 观测隔离。
 * 主进程服务存在无扩展名相对导入，先按 ipc-registry 冒烟的约定 esbuild 打包再直接执行。
 * 运行：node scripts/smoke/task-reader.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import assert from 'node:assert/strict'

const workDir = mkdtempSync(join(tmpdir(), 'tpanel-task-reader-'))
const abs = (p) => join(process.cwd(), p).replace(/\\/g, '/')
const entry = join(workDir, 'entry.ts')
writeFileSync(
  entry,
  [
    `export * from '${abs('src/main/services/documents/index.ts')}'`,
    `export { TrellisWatcher } from '${abs('src/main/services/watcher.ts')}'`,
    `export { scanProject, searchDocs } from '${abs('src/main/services/scan.ts')}'`,
    `export { DOCUMENT_READ_LIMIT_BYTES } from '${abs('src/shared/documents.ts')}'`
  ].join('\n'),
  'utf-8'
)
const bundle = join(workDir, 'bundle.mjs')
const requireBanner = "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
execFileSync(
  process.execPath,
  [
    join('node_modules', 'esbuild', 'bin', 'esbuild'),
    entry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--banner:js=${requireBanner}`,
    `--outfile=${bundle}`
  ],
  { stdio: 'inherit' }
)

const {
  readDocument,
  invalidateDocument,
  clearDocumentCache,
  MAX_DOCUMENT_READ_RETRIES,
  isPanelRuntimePath,
  TrellisWatcher,
  scanProject,
  searchDocs,
  DOCUMENT_READ_LIMIT_BYTES
} = await import(pathToFileURL(bundle).href)

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
  if (!cond) failures += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(predicate, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return true
    await sleep(100)
  }
  return predicate()
}

const SCOPE = { workspaceId: 'ws-smoke', taskRef: 'demo' }
const read = (root, relativePath, requestId = 'req-1') => readDocument(root, SCOPE, { relativePath, requestId })

/* ---------------- 夹具 ---------------- */

const root = mkdtempSync(join(tmpdir(), 'task-reader-fix-'))
const outsideRoot = mkdtempSync(join(tmpdir(), 'task-reader-out-'))
const taskDir = join(root, '.trellis', 'tasks', '10-11-demo')
mkdirSync(taskDir, { recursive: true })
mkdirSync(join(root, 'src'), { recursive: true })
mkdirSync(join(root, 'docs', 'guides'), { recursive: true })
writeFileSync(join(root, 'src', 'main.ts'), 'export {}\n')

const taskJson = {
  id: 'demo',
  name: 'demo',
  title: '演示任务',
  status: 'in_progress',
  priority: 'P1',
  assignee: null,
  creator: 'bob',
  createdAt: '2026-10-11',
  completedAt: null,
  description: '业务描述',
  subtasks: ['a', 'b'],
  meta: { jiraKey: 'X-1' },
  customUnknown: { deep: true },
  futureField: 7
}
const taskJsonPath = '.trellis/tasks/10-11-demo/task.json'
writeFileSync(join(root, taskJsonPath), JSON.stringify(taskJson, null, 2) + '\n', 'utf-8')

const manifestLines = [
  '{"file":"src/main.ts","reason":"入口"}',
  '',
  '{"file": broken json',
  '{"file":"docs/guides","reason":"目录参考","type":"directory","weight":2}',
  'plain text line',
  '{"file":"missing/artifact.md","reason":"不存在"}',
  '{"file":"../outside-root.md","reason":"越界相对路径"}',
  JSON.stringify({ file: join(dirname(root), 'outside-abs.md'), reason: '根外绝对路径' })
]
const manifestPath = '.trellis/tasks/10-11-demo/implement.jsonl'
writeFileSync(join(root, manifestPath), manifestLines.join('\n') + '\n', 'utf-8')

try {
  /* ---------------- 1. task.json 结构化 + 未知字段保留 ---------------- */

  const tj = await read(root, taskJsonPath)
  check('task.json 读取成功', tj.ok === true)
  if (tj.ok === true) {
    check('requestId 原样回显', tj.requestId === 'req-1')
    check('revision 非空', typeof tj.revision === 'string' && tj.revision.length === 16)
    check('原文始终可取（含尾部换行）', tj.rawText === JSON.stringify(taskJson, null, 2) + '\n')
    check('解析 kind 为 task-json', tj.parsed?.kind === 'task-json')
    if (tj.parsed?.kind === 'task-json') {
      check(
        '常见字段结构化（原样字符串，不映射阶段）',
        tj.parsed.fields.id === 'demo' &&
          tj.parsed.fields.title === '演示任务' &&
          tj.parsed.fields.status === 'in_progress' &&
          tj.parsed.fields.priority === 'P1' &&
          tj.parsed.fields.creator === 'bob' &&
          tj.parsed.fields.createdAt === '2026-10-11'
      )
      const uf = tj.parsed.unknownFields
      check(
        '未知字段原样保留（含未知对象与未来字段）',
        uf.customUnknown !== undefined &&
          uf.futureField === 7 &&
          JSON.stringify(uf.meta) === JSON.stringify({ jiraKey: 'X-1' })
      )
      check('未结构化的已知字段不隐藏（description/subtasks 原样在 unknownFields）', uf.description === '业务描述' && Array.isArray(uf.subtasks))
      check('常见字段键的非字符串值不隐藏（assignee=null 原样保留）', 'assignee' in uf && uf.assignee === null)
    }
    check('scope 回显在 source', tj.source.workspaceId === 'ws-smoke' && tj.source.taskRef === 'demo')
    check('relativePath 归一化', tj.source.relativePath === taskJsonPath)
  }

  /* ---------------- 2. jsonl 清单：坏行真实行号 + 空行不改编号 ---------------- */

  const mf = await read(root, manifestPath)
  check('implement.jsonl 读取成功', mf.ok === true)
  if (mf.ok === true) {
    const parsed = mf.parsed
    check('解析 kind 为 context-manifest', parsed?.kind === 'context-manifest')
    if (parsed?.kind === 'context-manifest') {
      check('好行进入 entries（顺序即清单顺序）', parsed.entries.length === 5)
      check(
        '真实行号：空行不改编号（1/4/6/7/8，而非压缩后序号）',
        parsed.entries.map((e) => e.line).join(',') === '1,4,6,7,8'
      )
      const dirEntry = parsed.entries[1]
      check('type: directory 识别且未知字段 weight 原样保留', dirEntry.type === 'directory' && dirEntry.extra.weight === 2)
      check('目录条目 present 且 sizeBytes 为 null（不填 0）', dirEntry.readability.status === 'present' && dirEntry.readability.sizeBytes === null)
      const present = parsed.entries[0]
      check('存在文件条目 present 且带字节数', present.readability.status === 'present' && present.readability.sizeBytes === 'export {}\n'.length)
      const missing = parsed.entries[2]
      check('缺失文件条目 missing 且 sizeBytes 为 null', missing.readability.status === 'missing' && missing.readability.sizeBytes === null)
      const outside = parsed.entries[3]
      check('越界相对路径条目 readability=unknown（不探测根外文件）', outside.readability.status === 'unknown' && outside.readability.sizeBytes === null)
      const absEntry = parsed.entries[4]
      check('绝对路径条目 readability=unknown（不探测根外文件）', absEntry.readability.status === 'unknown' && absEntry.readability.sizeBytes === null)
      check(
        '解析结果不包含任何执行时间语义（键集合固定）',
        Object.keys(parsed.entries[0]).sort().join(',') === 'extra,file,line,readability,reason,type' &&
          Object.keys(parsed).sort().join(',') === 'entries,kind,totals'
      )
      check('totals 计数（entries/badLines/blankLines）', parsed.totals.entries === 5 && parsed.totals.badLines === 2 && parsed.totals.blankLines === 1)
    }
    const badLines = mf.diagnostics.filter((d) => d.code === 'manifest_bad_line')
    check('坏行以诊断条目呈现（2 条）', badLines.length === 2)
    check(
      '坏行诊断携带真实行号（3 与 5，空行占位 2 不改编号）',
      badLines.map((d) => d.data.line).join(',') === '3,5'
    )
    check('坏行诊断附原始行文本', String(badLines[0].data.raw).includes('broken') && String(badLines[1].data.raw) === 'plain text line')
  }

  /* ---------------- 3. revision 随内容变化 + 定向失效 ---------------- */

  const prdPath = '.trellis/tasks/10-11-demo/prd.md'
  writeFileSync(join(root, prdPath), '# v1\n', 'utf-8')
  const v1 = await read(root, prdPath)
  const v1Again = await read(root, prdPath)
  check('同内容两次读取 revision 一致', v1.ok === true && v1Again.ok === true && v1.revision === v1Again.revision)
  writeFileSync(join(root, prdPath), '# v2\n', 'utf-8')
  const v2 = await read(root, prdPath)
  check('内容变化后 revision 变化', v2.ok === true && v2.revision !== v1.revision)

  const tj1 = await read(root, taskJsonPath)
  const tj2 = await read(root, taskJsonPath)
  check(
    '缓存命中复用解析结果（canonicalPath+revision 定向缓存）',
    tj1.ok === true && tj2.ok === true && tj1.parsed === tj2.parsed
  )
  if (tj1.ok === true) {
    const removed = invalidateDocument(tj1.source.canonicalPath, 'deadbeefdeadbeef')
    const tjStillCached = await read(root, taskJsonPath)
    check('revision 不匹配的失效请求不动缓存', removed === false && tjStillCached.ok === true && tjStillCached.parsed === tj1.parsed)
    const removedReal = invalidateDocument(tj1.source.canonicalPath, tj1.revision)
    const tjFresh = await read(root, taskJsonPath)
    check('按 canonicalPath+revision 定向失效后重建解析', removedReal === true && tjFresh.ok === true && tjFresh.parsed !== tj1.parsed)
  }

  /* ---------------- 4. 坏 JSON / 半写容错 ---------------- */

  const corruptDir = join(root, '.trellis', 'tasks', '10-11-corrupt')
  mkdirSync(corruptDir, { recursive: true })
  const brokenPath = '.trellis/tasks/10-11-corrupt/task.json'
  // 半写形态：截断的 JSON（写入中断时磁盘上的样子）
  writeFileSync(join(root, brokenPath), '{"title": "半写", "status": "in_prog', 'utf-8')
  const broken = await readDocument(root, SCOPE, { relativePath: brokenPath, requestId: 'req-broken' })
  check('半写 task.json 不当请求失败（ok:true）', broken.ok === true)
  if (broken.ok === true) {
    const parseDiag = broken.diagnostics.find((d) => d.code === 'parse_failed')
    check('解析失败诊断（error 级，附重试次数 2）', parseDiag !== undefined && parseDiag.severity === 'error' && parseDiag.data.attempts === 2)
    check('损坏 JSON 不当空任务（parsed=null）', broken.parsed === null)
    check('解析失败不丢原文', broken.rawText !== null && broken.rawText.includes('半写'))
    check('内容 revision 仍可用作版本标识', typeof broken.revision === 'string' && broken.revision.length === 16)
    check('半写期间无文件变化伪装（无 read_retried/成功诊断混入）', broken.diagnostics.every((d) => d.code === 'parse_failed'))
  }
  check('重试上限 ≤2（design §5.2）', MAX_DOCUMENT_READ_RETRIES === 2)

  /* ---------------- 5. 缺失文件明确空态 ---------------- */

  const absent = await read(root, '.trellis/tasks/10-11-demo/design.md')
  check('缺失文件 ok:true + file_missing 中性诊断（未知/空态不用错误伪装）', absent.ok === true && absent.diagnostics[0]?.code === 'file_missing' && absent.diagnostics[0]?.severity === 'neutral' && absent.rawText === null)

  /* ---------------- 6. 5MiB 限额 ---------------- */

  const bigPath = '.trellis/tasks/10-11-demo/big.md'
  writeFileSync(join(root, bigPath), Buffer.alloc(DOCUMENT_READ_LIMIT_BYTES + 1, 0x61))
  const big = await read(root, bigPath)
  check('超限 ok:true + document_too_large 诊断', big.ok === true && big.diagnostics[0]?.code === 'document_too_large')
  if (big.ok === true) {
    const d = big.diagnostics[0]
    check('超限诊断含实际大小与限额数据', d.data.sizeBytes === DOCUMENT_READ_LIMIT_BYTES + 1 && d.data.limitBytes === DOCUMENT_READ_LIMIT_BYTES)
    check('超限诊断含本机打开提示数据', d.data.openLocally === true)
    check('超限不装载全文（rawText/revision 为 null）', big.rawText === null && big.revision === null)
  }
  const exactPath = '.trellis/tasks/10-11-demo/exact.md'
  writeFileSync(join(root, exactPath), Buffer.alloc(DOCUMENT_READ_LIMIT_BYTES, 0x62))
  const exact = await read(root, exactPath)
  check('正好 5MiB 可完整读取', exact.ok === true && exact.revision !== null && exact.rawText.length === DOCUMENT_READ_LIMIT_BYTES)

  /* ---------------- 7. 路径边界 ---------------- */

  const esc1 = await read(root, '../../../etc/passwd')
  check('.. 逃逸拒绝（E_INVALID_ARG）', esc1.ok === false && esc1.code === 'E_INVALID_ARG')
  const esc2 = await read(root, join(outsideRoot, 'secret.md'))
  check('绝对路径（根外）拒绝', esc2.ok === false && esc2.code === 'E_INVALID_ARG')

  writeFileSync(join(outsideRoot, 'secret.md'), 'outside\n', 'utf-8')
  const linkPath = join(taskDir, 'research-link')
  try {
    symlinkSync(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    const esc3 = await read(root, '.trellis/tasks/10-11-demo/research-link/secret.md')
    check('软链接逃逸拒绝（junction 指向根外）', esc3.ok === false && esc3.code === 'E_INVALID_ARG')
  } catch (e) {
    check('软链接逃逸拒绝（本机无法创建链接，跳过）', true, `skipped: ${e.message}`)
  }

  /* ---------------- 8. 观测 runtime 隔离 ---------------- */

  check(
    'isPanelRuntimePath 精确匹配 .panel/runtime（不扩大到整个 .panel）',
    isPanelRuntimePath('.trellis/.panel/runtime/x.sqlite') &&
      isPanelRuntimePath('C:\\a\\.trellis\\.panel\\runtime') &&
      !isPanelRuntimePath('.trellis/.panel/approval.md') &&
      !isPanelRuntimePath('.trellis/.panelx/runtime/a') &&
      !isPanelRuntimePath('a/b/runtime')
  )

  const watcherRoot = mkdtempSync(join(tmpdir(), 'task-reader-watch-'))
  mkdirSync(join(watcherRoot, '.trellis', 'tasks', 'demo'), { recursive: true })
  // runtime 目录预先存在（ignoreInitial 不触发初始事件），负向断言只测"写入"
  mkdirSync(join(watcherRoot, '.trellis', '.panel', 'runtime'), { recursive: true })
  const events = []
  const w = new TrellisWatcher()
  w.start(watcherRoot, () => events.push('change'), (p) => events.push(`file:${p}`))
  await sleep(1000) // chokidar 初始化
  writeFileSync(join(watcherRoot, '.trellis', 'tasks', 'demo', 'prd.md'), '# v1\n', 'utf-8')
  const controlFired = await waitFor(() => events.length > 0, 6000)
  check('控制组：.trellis 内普通文件写入触发 watcher', controlFired)
  await sleep(700) // 等防抖 onChange（300ms）落地，避免计入负向断言的基线
  const before = events.length
  writeFileSync(join(watcherRoot, '.trellis', '.panel', 'runtime', 'observations.sqlite'), 'x'.repeat(256))
  writeFileSync(join(watcherRoot, '.trellis', '.panel', 'runtime', 'binding.json'), '{}\n')
  await sleep(1800) // 大于 300ms 防抖窗 + 事件延迟
  check('.panel/runtime 写入不触发 watcher 回调（回执写入不重扫全项目）', events.length === before)
  // design §4.1：精确忽略 runtime，不扩大到整个 .panel——批准资料类文件仍应可见
  const beforePanel = events.length
  writeFileSync(join(watcherRoot, '.trellis', '.panel', 'approval.md'), '# approval\n', 'utf-8')
  const panelFired = await waitFor(() => events.length > beforePanel, 6000)
  check('.panel 下非 runtime 文件仍被普通扫描看见（不扩大忽略范围）', panelFired)
  await sleep(700) // 同上：让最后一轮防抖落地后再进入快照断言
  w.stop()

  const snap = scanProject(watcherRoot)
  check('scanProject 快照不包含 .panel 内容', !JSON.stringify(snap).includes('.panel'))
  const docs = searchDocs(watcherRoot, '', 'all')
  check('docs 检索不索引 .panel 内容', docs.ok !== true || !docs.hits.some((h) => h.path.includes('.panel')))
  rmSync(watcherRoot, { recursive: true, force: true })
} finally {
  clearDocumentCache()
  rmSync(root, { recursive: true, force: true })
  rmSync(outsideRoot, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`任务读取器冒烟：${failures} 项失败`)
  process.exit(1)
}
console.log('任务读取器冒烟：全部通过 ✓')
