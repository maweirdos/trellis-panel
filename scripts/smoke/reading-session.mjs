/**
 * 阅读会话冒烟（S0 G2 第二片，implement.md §4）：node scripts/smoke/reading-session.mjs
 * 覆盖——
 *   1) 阅读会话状态机纯函数：base/displayed/latest 三态流转（外部变化不自动切换、
 *      阅读新版不改首次基线、以当前为基线重置、关闭即丢弃）；
 *   2) diff 纯计算：统一单列结构、控制字符剥离与纯文本输出（转义红线）、一致短路；
 *   3) diff 服务（真实 worker 线程）：正常路径、每侧 2MiB 上限、1s 超时（人为小阈值）
 *      的降级诊断与恢复；
 *   4) Git 最近提交基线：无仓库/无提交/未跟踪/路径不在提交中的中性降级、
 *      committed 内容一致、基线超限映射（临时 git 夹具；git 不可用则如实跳过并标注）。
 * 主进程服务存在无扩展名相对导入，按 ipc-registry/task-reader 冒烟约定先 esbuild 打包。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import assert from 'node:assert/strict'

const abs = (p) => join(process.cwd(), p).replace(/\\/g, '/')
const workDir = mkdtempSync(join(tmpdir(), 'tpanel-reading-session-'))
const requireBanner = "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"

/* ---------------- 打包：主服务 + 渲染端纯逻辑 + diff worker ---------------- */

const entry = join(workDir, 'entry.ts')
writeFileSync(
  entry,
  [
    `export * from '${abs('src/main/services/documents/index.ts')}'`,
    // diff-worker 纯函数直接引用（documents/index 不 re-export，避免生产 rollup 双入口耦合）
    `export { computeUnifiedDiff, sanitizeDiffLine } from '${abs('src/main/services/documents/diff-worker.ts')}'`,
    `export * from '${abs('src/renderer/src/reader/reading-session.ts')}'`,
    `export * from '${abs('src/renderer/src/reader/reader-prefs.ts')}'`,
    `export * from '${abs('src/renderer/src/reader/heading-anchors.ts')}'`,
    `export { DOCUMENT_DIFF_SIDE_LIMIT_BYTES, DOCUMENT_DIFF_TIMEOUT_MS } from '${abs('src/shared/documents.ts')}'`
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
    `--outfile=${bundle}`
  ],
  { stdio: 'inherit' }
)
const workerBundle = join(workDir, 'diff-worker.mjs')
execFileSync(
  process.execPath,
  [
    join('node_modules', 'esbuild', 'bin', 'esbuild'),
    abs('src/main/services/documents/diff-worker.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${workerBundle}`
  ],
  { stdio: 'inherit' }
)
// ESM bundle 无 __filename：worker 文件必须显式指定（与生产 CJS 邻位定位互补）
process.env.TRELLIS_DIFF_WORKER_FILE = workerBundle

const m = await import(pathToFileURL(bundle).href)
const {
  computeUnifiedDiff,
  sanitizeDiffLine,
  computeDocumentDiff,
  stopDiffWorker,
  latestCommitBaseline,
  computeRevision,
  sessionOpened,
  externalChangeDetected,
  readNewVersion,
  rebaseToCurrent,
  closeSession,
  hasPendingUpdate,
  compareTargets,
  readingSessionKey,
  EMPTY_READING_SESSION,
  computeHeadingAnchors,
  headingAnchorsByLine,
  headingSlug,
  parseReaderWidthPref,
  isReaderWidthPref,
  DOCUMENT_DIFF_SIDE_LIMIT_BYTES,
  DOCUMENT_DIFF_TIMEOUT_MS
} = m

let failures = 0
let assertions = 0
const check = (name, cond, extra = '') => {
  assertions += 1
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
  if (!cond) failures += 1
}

const SCOPE = { workspaceId: 'ws-smoke', taskRef: 'demo' }

try {
  /* ---------------- 1. 阅读会话状态机（design §6.2） ---------------- */

  const v1 = { revision: 'r1', text: '# v1\n' }
  const v2 = { revision: 'r2', text: '# v2\n' }
  const v3 = { revision: 'r3', text: '# v3\n' }

  const opened = sessionOpened(EMPTY_READING_SESSION, v1)
  check('首次成功加载建立 base/displayed（同版）', opened.base === v1 && opened.displayed === v1 && opened.latest === null)

  const ext2 = externalChangeDetected(opened, v2)
  check(
    '外部变化只更新 latest 标记，不自动切换 base/displayed',
    ext2.latest === v2 && ext2.displayed === v1 && ext2.base === v1
  )
  check('外部变化后存在待处理更新提示', hasPendingUpdate(ext2) === true)

  const extSame = externalChangeDetected(ext2, v1)
  check('候选与当前展示同版时清除提示', extSame.latest === null && extSame.displayed === v1 && hasPendingUpdate(extSame) === false)

  const ext3 = externalChangeDetected(ext2, v3)
  check('连续外部变化取最新候选（v2→v3 覆盖）', ext3.latest === v3 && ext3.displayed === v1)

  const readNew = readNewVersion(ext3)
  check(
    '「阅读新版」替换 displayed 且不改首次基线',
    readNew.displayed === v3 && readNew.base === v1 && readNew.latest === null
  )
  check('阅读新版后无更新提示', hasPendingUpdate(readNew) === false)
  check('无候选时「阅读新版」为 no-op', readNewVersion(readNew) === readNew)

  const targets = compareTargets(ext3)
  check('「查看变化」目标 = 当前展示版 vs 最新候选', targets.current === v1 && targets.candidate === v3)
  check('无更新时「查看变化」候选为 null（调用方回退最近提交基线）', compareTargets(readNew).candidate === null)

  const rebased = rebaseToCurrent(readNew)
  check('「以当前为本次基线」base := displayed（latest 提示保留）', rebased.base === v3 && rebased.displayed === v3)
  check('基线已是当前版时 rebase 为 no-op', rebaseToCurrent(rebased) === rebased)
  check('未成功加载（displayed=null）时 rebase 为 no-op', rebaseToCurrent(EMPTY_READING_SESSION) === EMPTY_READING_SESSION)

  const closed = closeSession()
  check('文档关闭将会话快照全部丢弃（无跨重启草稿）', closed.base === null && closed.displayed === null && closed.latest === null)

  check(
    '会话键归一化反斜杠且含 taskRef 段',
    readingSessionKey(SCOPE, 'a\\b\\prd.md') === 'ws-smoke::demo::a/b/prd.md' &&
      readingSessionKey({ workspaceId: 'ws' }, 'x.md') === 'ws::::x.md'
  )

  /* ---------------- 2. 标题锚点（稳定 heading ID） ---------------- */

  const md = [
    '# Hello World',
    '',
    '```',
    '# not a heading',
    '```',
    '',
    "## What's new?!",
    '## 概述',
    '## 概述',
    '',
    'Title',
    '===',
    '',
    'Sub',
    '---',
    '',
    '- item',
    '---',
    ''
  ].join('\n')
  const anchors = computeHeadingAnchors(md)
  const ids = anchors.map((a) => a.id)
  check(
    'ATX 标题解析 + 围栏内井号不算标题',
    ids.includes('hello-world') && !ids.includes('not-a-heading')
  )
  check("特殊字符 slug（What's new?! → whats-new，撇号/标点被剥离）", ids.includes('whats-new') === true && !ids.includes("what's-new"))
  check('重复标题去重（概述 / 概述-1）', ids.filter((x) => x.startsWith('概述')).join(',') === '概述,概述-1')
  check('setext 下划线标题（= 一级 / - 二级）', anchors.some((a) => a.level === 1 && a.text === 'Title') && anchors.some((a) => a.level === 2 && a.text === 'Sub'))
  check('列表后的 --- 不算 setext 标题', !anchors.some((a) => a.text === 'item'))
  const byLine = headingAnchorsByLine(md)
  check('行号映射表（ATX=井号行，setext=文本行）', byLine.get(1) === 'hello-world' && byLine.get(11) === 'title' && byLine.get(14) === 'sub')
  check('CRLF 标题与 LF 的文本、层级、去重 ID 和源行号完全一致（含围栏与 setext）', JSON.stringify(computeHeadingAnchors(md.replace(/\n/g, '\r\n'))) === JSON.stringify(anchors))
  check('混合 CRLF/LF/单独 CR 行尾保持标题与渲染器一致的源行号', JSON.stringify(computeHeadingAnchors('# One\r\n\r\n## Two\r\n\rTitle\r===\n')) === JSON.stringify([
    { level: 1, text: 'One', id: 'one', line: 1 }, { level: 2, text: 'Two', id: 'two', line: 3 }, { level: 1, text: 'Title', id: 'title', line: 5 }
  ]))
  check('空 slug 回退 section', headingSlug('!!!') === 'section')

  /* ---------------- 3. 阅读宽度偏好 ---------------- */

  check('宽度偏好解析（合法档位）', parseReaderWidthPref('880') === 880 && parseReaderWidthPref('680') === 680)
  check('宽度偏好解析（缺失/非法回默认 760）', parseReaderWidthPref(null) === 760 && parseReaderWidthPref('999') === 760 && parseReaderWidthPref('abc') === 760)
  check('三档常量（680/760/880）', isReaderWidthPref(680) && isReaderWidthPref(760) && isReaderWidthPref(880) && !isReaderWidthPref(700))

  /* ---------------- 4. diff 纯计算：统一单列结构 + 转义红线 ---------------- */

  const oldSample = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n'
  const newSample = 'a\nb\nX\nd\ne\nf\ng\nh\ni\nj\nk\nY\n'
  const core = computeUnifiedDiff(oldSample, newSample, 3)
  check('两处变更折叠为两个 hunk（间隔 > 2×context）', core.hunks.length === 2 && core.identical === false)
  check(
    'hunk 头行号与行数（@@ -1,6 +1,6 @@ / @@ -9,4 +9,4 @@）',
    core.hunks[0].oldStart === 1 && core.hunks[0].oldLines === 6 && core.hunks[0].newStart === 1 && core.hunks[0].newLines === 6 &&
      core.hunks[1].oldStart === 9 && core.hunks[1].oldLines === 4 && core.hunks[1].newLines === 4
  )
  const h1Lines = core.hunks[0].lines
  check(
    '统一单列行结构（context/removed/added + 双侧行号）',
    h1Lines.map((l) => `${l.type}:${l.oldLine ?? '-'}:${l.newLine ?? '-'}:${l.text}`).join('|') ===
      'context:1:1:a|context:2:2:b|removed:3:-:c|added:-:3:X|context:4:4:d|context:5:5:e|context:6:6:f'
  )
  check('统计（added 2 / removed 2 / context 8）', core.stats.added === 2 && core.stats.removed === 2 && core.stats.context === 8)
  check('一致文本 identical=true 且无 hunk', computeUnifiedDiff('x\ny\n', 'x\ny\n', 3).identical === true && computeUnifiedDiff('x\ny\n', 'x\ny\n', 3).hunks.length === 0)

  check(
    '纯文本输出：HTML 标记原样为惰性文本（不生成实体/标记）',
    sanitizeDiffLine('<script>alert(1)</script>') === '<script>alert(1)</script>'
  )
  check('控制字符剥离（ESC/DEL/C1 不进入输出）', sanitizeDiffLine('\u001b[31mred\u001b[0m') === '[31mred[0m' && sanitizeDiffLine('a\u0007b\u007fc\u009fd') === 'abcd')
  const escOld = 'line1\n<script>alert(1)</script>\n\u001b[31mred\u001b[0m\n'
  const escNew = 'line1\n<script>alert(1)</script>\n'
  const escCore = computeUnifiedDiff(escOld, escNew, 3)
  const removedTexts = escCore.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'removed').map((l) => l.text))
  check(
    'diff 行输出为纯文本（脚本标记原样、ESC 序列已剥离）',
    removedTexts.includes('[31mred[0m') && escCore.hunks.some((h) => h.lines.some((l) => l.text === '<script>alert(1)</script>'))
  )

  /* ---------------- 5. diff 服务（真实 worker 线程） ---------------- */

  const plainRoot = mkdtempSync(join(tmpdir(), 'reading-plain-'))
  const textBaseline = (oldText, newText, overrides) =>
    computeDocumentDiff(
      plainRoot,
      SCOPE,
      {
        requestId: 'req-diff',
        relativePath: '.trellis/tasks/demo/prd.md',
        baseline: { kind: 'text', side: { text: oldText, revision: 'old-rev' } },
        current: { text: newText, revision: 'new-rev' }
      },
      overrides
    )

  const svcDiff = await textBaseline(oldSample, newSample)
  check('服务路径（worker 线程）返回 diff', svcDiff.ok === true && svcDiff.diff !== null && svcDiff.diff.hunks.length === 2)
  if (svcDiff.ok === true && svcDiff.diff !== null) {
    check('侧信息（provided 基线 + revision 透传）', svcDiff.diff.left.origin === 'provided' && svcDiff.diff.left.revision === 'old-rev' && svcDiff.diff.right.revision === 'new-rev')
    check('elapsedMs 为非负时长毫秒数', typeof svcDiff.diff.elapsedMs === 'number' && svcDiff.diff.elapsedMs >= 0)
  }
  const svcSame = await textBaseline('same\n', 'same\n')
  check('一致短路（不走 worker，identical=true）', svcSame.ok === true && svcSame.diff?.identical === true && svcSame.diff.hunks.length === 0 && svcSame.diff.elapsedMs === 0)

  const bigCurrent = 'x'.repeat(DOCUMENT_DIFF_SIDE_LIMIT_BYTES + 1)
  const svcBig = await textBaseline('a\n', bigCurrent)
  check('当前侧超 2MiB：ok:true + diff_side_too_large 降级诊断', svcBig.ok === true && svcBig.diff === null && svcBig.diagnostics[0]?.code === 'diff_side_too_large')
  if (svcBig.ok === true) {
    const d = svcBig.diagnostics[0]
    check('超限诊断附 side/limit 与原文对比、本机打开建议数据', d.data.side === 'current' && d.data.limitBytes === DOCUMENT_DIFF_SIDE_LIMIT_BYTES && d.data.openLocally === true && d.data.rawCompare === true)
  }
  const bigBaseline = await textBaseline(bigCurrent.slice(0, DOCUMENT_DIFF_SIDE_LIMIT_BYTES + 2), 'y\n')
  check('基准侧超限同样降级（side=baseline）', bigBaseline.ok === true && bigBaseline.diff === null && bigBaseline.diagnostics[0]?.data.side === 'baseline')

  // 超时：人为 1ms 阈值（worker 线程拉起本身即超预算）→ 明确诊断 + 不冻结 + 后续可恢复
  const slowOld = Array.from({ length: 4000 }, (_, i) => `common-${i % 7}\nold-${i}\n`).join('')
  const slowNew = Array.from({ length: 4000 }, (_, i) => `common-${i % 7}\nnew-${i}\n`).join('')
  const svcTimeout = await textBaseline(slowOld, slowNew, { timeoutMs: 1 })
  check('计算超时：ok:true + diff_timeout 诊断（diff=null，不冻结）', svcTimeout.ok === true && svcTimeout.diff === null && svcTimeout.diagnostics[0]?.code === 'diff_timeout')
  if (svcTimeout.ok === true) {
    const d = svcTimeout.diagnostics[0]
    check('超时诊断附 timeoutMs 与原文对比/本机打开建议', d.data.timeoutMs === 1 && d.data.openLocally === true && d.data.rawCompare === true && d.message.includes('原文对比'))
  }
  check('默认超时预算为 1000ms（design §6.2）', DOCUMENT_DIFF_TIMEOUT_MS === 1000)
  const svcRecover = await textBaseline(oldSample, newSample)
  check('超时终止后下一次调用自动重建 worker 并成功', svcRecover.ok === true && svcRecover.diff?.hunks.length === 2)

  const badScope = await computeDocumentDiff(plainRoot, { taskRef: 'x' }, { requestId: 'r', relativePath: 'a.md', baseline: { kind: 'git-latest-commit' }, current: { text: '', revision: null } })
  check('scope 非法 → E_INVALID_ARG（请求级失败）', badScope.ok === false && badScope.code === 'E_INVALID_ARG')
  const badInput = await computeDocumentDiff(plainRoot, SCOPE, { requestId: '', relativePath: 'a.md', baseline: { kind: 'nope' }, current: { text: '', revision: null } })
  check('参数非法（baseline 未知 kind）→ E_INVALID_ARG', badInput.ok === false && badInput.code === 'E_INVALID_ARG')

  /* ---------------- 5b. 生产 CJS 路径：__filename 邻位定位 worker（不依赖 env 覆盖） ---------------- */

  {
    const cjsDir = join(workDir, 'cjs')
    mkdirSync(cjsDir, { recursive: true })
    // 服务按 CJS 打包（与 out/main/index.js 同形态）：__filename = svc.cjs 所在目录
    execFileSync(
      process.execPath,
      [
        join('node_modules', 'esbuild', 'bin', 'esbuild'),
        abs('src/main/services/documents/diff-service.ts'),
        '--bundle',
        '--format=cjs',
        '--platform=node',
        `--outfile=${join(cjsDir, 'svc.cjs')}`
      ],
      { stdio: 'inherit' }
    )
    // worker 以约定名 diff-worker.js 落在服务邻位（与 electron.vite.config.ts 插件输出一致）
    execFileSync(
      process.execPath,
      [
        join('node_modules', 'esbuild', 'bin', 'esbuild'),
        abs('src/main/services/documents/diff-worker.ts'),
        '--bundle',
        '--format=cjs',
        '--platform=node',
        `--outfile=${join(cjsDir, 'diff-worker.js')}`
      ],
      { stdio: 'inherit' }
    )
    const savedEnv = process.env.TRELLIS_DIFF_WORKER_FILE
    delete process.env.TRELLIS_DIFF_WORKER_FILE
    try {
      const { createRequire } = await import('module')
      const cjsRequire = createRequire(pathToFileURL(join(cjsDir, 'svc.cjs')).href)
      const cjsSvc = cjsRequire('./svc.cjs')
      const cjsResult = await cjsSvc.computeDocumentDiff(
        plainRoot,
        SCOPE,
        {
          requestId: 'req-cjs',
          relativePath: '.trellis/tasks/demo/prd.md',
          baseline: { kind: 'text', side: { text: oldSample, revision: null } },
          current: { text: newSample, revision: null }
        }
      )
      check('CJS 生产路径：__filename 邻位定位 diff-worker.js 并完成计算', cjsResult.ok === true && cjsResult.diff?.hunks.length === 2)
      cjsSvc.stopDiffWorker()
    } finally {
      if (savedEnv !== undefined) process.env.TRELLIS_DIFF_WORKER_FILE = savedEnv
    }
  }

  /* ---------------- 6. Git 最近提交基线（临时夹具） ---------------- */

  let gitAvailable = true
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
  } catch {
    gitAvailable = false
    console.log('  ⚠ 本机 git 不可用：git 基线断言按约定跳过（如实标注，不视为通过）')
  }

  const noRepo = await latestCommitBaseline(plainRoot, 'a.md')
  check('无仓库 → no-repo 中性降级（非错误伪装）', noRepo.status === 'no-repo' && noRepo.text === null && noRepo.message !== null)

  if (gitAvailable) {
    const gitRoot = mkdtempSync(join(tmpdir(), 'reading-git-'))
    const g = (args) => execFileSync('git', args, { cwd: gitRoot, stdio: 'ignore' })
    try {
      g(['init', '-q'])
      g(['config', 'core.autocrlf', 'false'])

      const noCommits = await latestCommitBaseline(gitRoot, 'a.md')
      check('无提交 → no-commits 中性降级', noCommits.status === 'no-commits' && noCommits.commit === null)

      writeFileSync(join(gitRoot, 'committed.md'), 'v1 line\n', 'utf-8')
      writeFileSync(join(gitRoot, 'untracked.md'), 'never added\n', 'utf-8')
      g(['add', 'committed.md'])
      execFileSync('git', ['-c', 'user.email=smoke@example.com', '-c', 'user.name=smoke', 'commit', '-q', '-m', 'c1'], { cwd: gitRoot, stdio: 'ignore' })

      const ok = await latestCommitBaseline(gitRoot, 'committed.md')
      check('committed 文件取回 HEAD 内容', ok.status === 'ok' && ok.text === 'v1 line\n' && /^[0-9a-f]{40}$/i.test(ok.commit ?? ''))
      check('基线 revision = 内容 sha256 前 16 hex', ok.revision === computeRevision(Buffer.from('v1 line\n', 'utf-8')))

      const untracked = await latestCommitBaseline(gitRoot, 'untracked.md')
      check('未跟踪 → untracked 中性降级', untracked.status === 'untracked' && untracked.text === null)

      writeFileSync(join(gitRoot, 'staged.md'), 'staged only\n', 'utf-8')
      g(['add', 'staged.md'])
      const notInCommit = await latestCommitBaseline(gitRoot, 'staged.md')
      check('已 add 未提交 → not-in-commit（说明可能重命名/未提交）', notInCommit.status === 'not-in-commit' && (notInCommit.message ?? '').includes('提交'))

      // 服务级：git 基线 + 当前草稿（未提交修改）→ 有差异
      const svcGit = await computeDocumentDiff(
        gitRoot,
        SCOPE,
        {
          requestId: 'req-git',
          relativePath: 'committed.md',
          baseline: { kind: 'git-latest-commit' },
          current: { text: 'v1 line\nv2 draft\n', revision: 'rev-draft' }
        }
      )
      check('「与最近提交比较」走通（left.origin=git-latest-commit + 提交哈希）', svcGit.ok === true && svcGit.diff?.left.origin === 'git-latest-commit' && svcGit.diff?.left.commit === ok.commit)
      if (svcGit.ok === true && svcGit.diff !== null) {
        const addedTexts = svcGit.diff.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'added').map((l) => l.text))
        check('未提交草稿行进入 added（覆盖未提交草稿是特性，diff 只读观察）', addedTexts.includes('v2 draft'))
      }

      // 基线超限：提交一个超 2MiB 的文件 → git show 收集被截断 → 映射 diff_side_too_large(baseline)
      const bigPath = join(gitRoot, 'big.md')
      writeFileSync(bigPath, 'b'.repeat(DOCUMENT_DIFF_SIDE_LIMIT_BYTES + 1024), 'utf-8')
      g(['add', 'big.md'])
      execFileSync('git', ['-c', 'user.email=smoke@example.com', '-c', 'user.name=smoke', 'commit', '-q', '-m', 'c2'], { cwd: gitRoot, stdio: 'ignore' })
      const svcGitBig = await computeDocumentDiff(
        gitRoot,
        SCOPE,
        {
          requestId: 'req-git-big',
          relativePath: 'big.md',
          baseline: { kind: 'git-latest-commit' },
          current: { text: 'small\n', revision: null }
        }
      )
      check('git 基线超 2MiB → too-large 映射 diff_side_too_large（side=baseline）', svcGitBig.ok === true && svcGitBig.diff === null && svcGitBig.diagnostics[0]?.code === 'diff_side_too_large' && svcGitBig.diagnostics[0]?.data.side === 'baseline')

      // git 不可用：清空 PATH → spawn ENOENT → git-unavailable（中性降级）
      const savedPath = process.env.PATH
      try {
        process.env.PATH = ''
        const unavailable = await latestCommitBaseline(gitRoot, 'committed.md')
        check('git 不可调用 → git-unavailable 中性降级', unavailable.status === 'git-unavailable' && unavailable.text === null)
      } finally {
        process.env.PATH = savedPath
      }

      // 恢复后再验证一次正常路径（PATH 复位无残留）
      const afterRecover = await latestCommitBaseline(gitRoot, 'committed.md')
      check('PATH 复位后 git 基线恢复可用', afterRecover.status === 'ok')
    } finally {
      rmSync(gitRoot, { recursive: true, force: true })
    }
  } else {
    const gitSkipNames = [
      '无提交 → no-commits 中性降级',
      'committed 文件取回 HEAD 内容',
      '基线 revision = 内容 sha256 前 16 hex',
      '未跟踪 → untracked 中性降级',
      '已 add 未提交 → not-in-commit（说明可能重命名/未提交）',
      '「与最近提交比较」走通（left.origin=git-latest-commit + 提交哈希）',
      '未提交草稿行进入 added（覆盖未提交草稿是特性，diff 只读观察）',
      'git 基线超 2MiB → too-large 映射 diff_side_too_large（side=baseline）',
      'git 不可调用 → git-unavailable 中性降级',
      'PATH 复位后 git 基线恢复可用'
    ]
    console.log(`  ⚠ 跳过 ${gitSkipNames.length} 项 git 夹具断言（git 不可用）`)
  }

  rmSync(plainRoot, { recursive: true, force: true })
} finally {
  // 退出收口（与 main/index.ts before-quit 同路径）
  stopDiffWorker()
  rmSync(workDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`阅读会话冒烟：${failures} 项失败（共 ${assertions} 项断言）`)
  process.exit(1)
}
console.log(`阅读会话冒烟：全部通过 ✓（${assertions} 项断言）`)
