/**
 * 观测契约冒烟（S0 G1-A / G1-C）：
 * 1) v1 事件 schema 的黄金夹具断言——合法事件通过、未知主版本进入 unsupported、
 *    违反 digest 口径进入 malformed；assembled/emitted 按 injectionId 配对。
 * 2) Python 生产者黄金夹具（scripts/fixtures/observability/python-produced-*.json，
 *    由真实 emitter 运行捕获）：通过 TS parseContextEvent，且 payloadDigest 与
 *    TS stableStringify 重算一致（跨语言 digest 口径，known-issues P3-b 偿还）。
 * 夹具位于 scripts/fixtures/observability/，Python 侧（Hook 生产者）复用同一组夹具。
 * 运行：node scripts/smoke/observability-contract.mjs
 */
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import assert from 'node:assert/strict'

const { parseContextEvent } = await import(new URL('../../src/shared/observability/schema.ts', import.meta.url).href)

const smokeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(smokeDir, '..', '..')
const fixtureDir = join(smokeDir, '..', 'fixtures', 'observability')
const load = (name) => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
  if (!cond) failures += 1
}

const assembled = parseContextEvent(load('context-assembled-ok.json'))
check('合法 assembled 事件通过', assembled.success === true)
if (assembled.success === true) {
  check('assembled 的 outputDigest 必须为 null', assembled.event.outputDigest === null)
  check(
    '五类材料结果完整表达（included/truncated/index_only+binary/missing/inline）',
    assembled.event.materials.length === 5 &&
      assembled.event.materials.map((m) => m.outcome).join(',') ===
        'included,truncated,index_only,missing,included'
  )
  check(
    'binary 以 index_only+reason 表达且不计入 included 字节',
    assembled.event.materials[2].reason === 'binary' && assembled.event.materials[2].includedBytes === null
  )
  check('missing 材料的字节口径为 null 而非 0', assembled.event.materials[3].sourceBytes === null)
  check('expectedEntries 未知为 null（不得计算缺失率）', assembled.event.totals.expectedEntries === null)
  check('未知字段 passthrough 保留', 'futureField' in assembled.event === true)
}

const emitted = parseContextEvent(load('context-emitted-ok.json'))
check('合法 emitted 事件通过', emitted.success === true)
if (assembled.success === true && emitted.success === true) {
  check(
    'assembled/emitted 共用 injectionId 可配对',
    assembled.event.injectionId === emitted.event.injectionId
  )
  check('emitted 携带 outputDigest 与 stdoutUtf8Bytes', emitted.event.outputDigest !== null && emitted.event.totals.stdoutUtf8Bytes !== null)
}

const badVersion = parseContextEvent(load('bad-schema-version.json'))
check(
  '未知主版本 → unsupported_schema_version（不按旧格式解释）',
  badVersion.success === false && badVersion.reason === 'unsupported_schema_version'
)

const badDigest = parseContextEvent(load('bad-digest.json'))
check(
  '非 64 位 hex digest → malformed 且给出定位',
  badDigest.success === false && badDigest.reason === 'malformed' && badDigest.issues.some((i) => i.includes('sourceDigest'))
)

/* 结构化构造：未归属事件（无任务绑定）必须合法 */
const unresolved = structuredClone(assembled.success === true ? assembled.event : {})
if ('scope' in unresolved) {
  unresolved.scope = { ...unresolved.scope, taskRef: null, trellisTaskId: null, taskPath: null, association: 'unresolved' }
  const r = parseContextEvent(unresolved)
  check('未归属（unresolved）事件合法，不强制猜任务', r.success === true)
}

/* 输出失败事件允许只有最小材料集 */
if ('kind' in unresolved) {
  const failed = { ...unresolved, kind: 'context.output_failed', diagnosticCode: 'stdout_broken_pipe' }
  const r = parseContextEvent(failed)
  check('output_failed 事件合法且诊断码保留', r.success === true && r.event.diagnosticCode === 'stdout_broken_pipe')
}

/* ---------------- Python 生产者黄金夹具（G1-C，跨语言 digest 证明） ---------------- */

{
  const assembledFixture = 'python-produced-assembled.json'
  const emittedFixture = 'python-produced-emitted.json'
  if (!existsSync(join(fixtureDir, assembledFixture)) || !existsSync(join(fixtureDir, emittedFixture))) {
    check('Python 生产者夹具存在', false, '缺失 python-produced-*.json（先运行 node scripts/smoke/hook-emitter.mjs --dump-fixtures scripts/fixtures/observability）')
  } else {
    // 真实 TS stableStringify（store-core）——通过 esbuild 打包加载（与 observability-store 冒烟同约定）
    const workDir = mkdtempSync(join(tmpdir(), 'tpanel-contract-'))
    const entry = join(workDir, 'entry.ts')
    writeFileSync(
      entry,
      `export { stableStringify } from '${(repoRoot + '/src/main/services/observability/store-core.ts').replace(/\\/g, '/')}'`,
      'utf-8'
    )
    const bundle = join(workDir, 'bundle.mjs')
    execFileSync(
      process.execPath,
      [join(repoRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'), entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`],
      { stdio: 'pipe' }
    )
    const { stableStringify } = await import(`file://${bundle.replace(/\\/g, '/')}`)

    const pyAssembled = load(assembledFixture)
    const pyEmitted = load(emittedFixture)

    const pa = parseContextEvent(pyAssembled.event)
    const pe = parseContextEvent(pyEmitted.event)
    check('Python assembled 事件通过 TS parseContextEvent', pa.success === true, pa.success === false ? pa.reason : '')
    check('Python emitted 事件通过 TS parseContextEvent', pe.success === true, pe.success === false ? pe.reason : '')
    if (pa.success !== true || pe.success !== true) {
      // 继续无意义
    } else {
      // 跨语言 digest 口径（P3-b）：Python stableStringify 产出的 payloadDigest 与 TS 重算一致
      const recomputedAssembled = sha256(Buffer.from(stableStringify(pa.event), 'utf8'))
      check(
        'Python assembled payloadDigest === TS stableStringify 重算',
        pyAssembled.payloadDigest === recomputedAssembled,
        `py=${(pyAssembled.payloadDigest || '').slice(0, 12)} ts=${recomputedAssembled.slice(0, 12)}`
      )
      const recomputedEmitted = sha256(Buffer.from(stableStringify(pe.event), 'utf8'))
      check(
        'Python emitted payloadDigest === TS stableStringify 重算',
        pyEmitted.payloadDigest === recomputedEmitted,
        `py=${(pyEmitted.payloadDigest || '').slice(0, 12)} ts=${recomputedEmitted.slice(0, 12)}`
      )
      check('Python 夹具 assembled/emitted 共用 injectionId', pa.event.injectionId === pe.event.injectionId)
      check('Python assembled 阶段无 outputDigest/stdout 字节数', pa.event.outputDigest === null && pa.event.totals.stdoutUtf8Bytes === null)
      // outputDigest 口径：实际输出上下文字段 UTF-8 的完整 SHA-256（contextText 由 emitter 捕获）
      if (typeof pyEmitted.contextText === 'string') {
        check(
          'Python emitted outputDigest === 上下文字段 SHA-256（TS 侧重算）',
          pe.event.outputDigest === sha256(Buffer.from(pyEmitted.contextText, 'utf8'))
        )
      } else {
        check('Python emitted 夹具携带 contextText（outputDigest 可独立复核）', false)
      }
      // 材料结果覆盖与字节口径（真实组装：含目录展开与缺失 artifact）
      const outcomes = new Set(pa.event.materials.map((m) => m.outcome))
      check(
        'Python assembled 材料覆盖 included/truncated/index_only/missing',
        ['included', 'truncated', 'index_only', 'missing'].every((o) => outcomes.has(o)),
        [...outcomes].join(',')
      )
      check('Python assembled totals 完整性口径', pa.event.totals.recordedEntries === pa.event.materials.length && pa.event.totals.expectedEntries === null && pa.event.totals.completeness === 'complete')
      const trunc = pa.event.materials.find((m) => m.outcome === 'truncated')
      if (check('Python assembled 含 truncated 材料', trunc !== undefined) && trunc) {
        check(
          'truncated 材料源/纳入字节与摘要分离',
          trunc.sourceBytes !== null && trunc.includedBytes !== null && trunc.includedBytes < trunc.sourceBytes && trunc.sourceDigest !== trunc.includedDigest
        )
      }
    }
  }
}

if (failures > 0) {
  console.error(`观测契约冒烟：${failures} 项失败`)
  process.exit(1)
}
console.log('观测契约冒烟：全部通过 ✓')
