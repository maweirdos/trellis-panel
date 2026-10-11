/**
 * 观测契约冒烟（S0 G1-A）：
 * v1 事件 schema 的黄金夹具断言——合法事件通过、未知主版本进入 unsupported、
 * 违反 digest 口径进入 malformed；assembled/emitted 按 injectionId 配对。
 * 夹具位于 scripts/fixtures/observability/，Python 侧（Hook 生产者）复用同一组夹具。
 * 运行：node scripts/smoke/observability-contract.mjs
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import assert from 'node:assert/strict'

const { parseContextEvent } = await import(new URL('../../src/shared/observability/schema.ts', import.meta.url).href)

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'observability')
const load = (name) => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'))

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

if (failures > 0) {
  console.error(`观测契约冒烟：${failures} 项失败`)
  process.exit(1)
}
console.log('观测契约冒烟：全部通过 ✓')
