/**
 * 回执/活动投影冒烟（S0 G3 第二片，design §3.3/§5.3）：node scripts/smoke/receipt-projection.mjs
 * 覆盖——
 *   1) ReceiptProjection：assembled+emitted 配对；仅 emitted（完整证据，assembled 丢失
 *      不使其消失）；仅 assembled；两者皆无 → unobserved；output_failed 输出失败事实；
 *      清单 partial/遗漏数透出；材料当时摘要与当前文件一致/不一致/无法核对/未核对；
 *      eventId 重复去重；时间倒序；明细被删减仍透出汇总遗漏数；
 *      措辞上限（「已输出至宿主通道」，不出现「已注入/已遵守」）。
 *   2) ActivityProjection：四列分列；同 id 跨来源不合并；任务原值状态不升级为阶段完成；
 *      任务视图过滤（未归属事件不进任务列）；归档位置从输入如实显示；时间倒序。
 *   3) observationHealthView：active=ok；paused(collection_disabled)=中性；
 *      配额暂停=提示；corrupted=错误；future_version=提示；not_initialized/closed=中性
 *      （未知 ≠ 故障：不标红）。
 * 渲染组件（ObservationPanel/EvidenceBadge 的 DOM 契约）不在纯 node 冒烟范围，
 * 列入 validation/observability.md 的人工走查清单。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'

const abs = (p) => join(process.cwd(), p).replace(/\\/g, '/')
const workDir = mkdtempSync(join(tmpdir(), 'tpanel-receipt-projection-'))

/* ---------------- 打包：共享投影（shared 层纯函数） ---------------- */

const entry = join(workDir, 'entry.ts')
writeFileSync(
  entry,
  [
    `export * from '${abs('src/shared/observability/receipt.ts')}'`,
    `export * from '${abs('src/shared/observability/activity.ts')}'`,
    `export { observationHealthView } from '${abs('src/shared/observability/store.ts')}'`
  ].join('\n'),
  'utf-8'
)
const bundle = join(workDir, 'bundle.mjs')
execFileSync(
  process.execPath,
  [join('node_modules', 'esbuild', 'bin', 'esbuild'), entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`],
  { stdio: 'inherit' }
)

const m = await import(pathToFileURL(bundle).href)
const { projectReceipts, evidenceWording, EVIDENCE_UNOBSERVED, MATERIAL_OUTCOME_LABELS, projectActivity, observationHealthView } = m

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
  if (!cond) failures += 1
}

/* ---------------- 夹具：符合 v1 契约的 ObservationItem ---------------- */

let evtSeq = 0
const digest = (c) => c.repeat(64)
const mkEvent = (over = {}) => {
  evtSeq += 1
  return {
    schemaVersion: 1,
    eventId: `evt-${evtSeq}`,
    injectionId: 'inj-1',
    kind: 'context.assembled',
    occurredAtMs: 1760172000000 + evtSeq * 1000,
    producer: { host: 'codex', hook: 'subagent-context', version: '0.1.0', capability: 'context.v1' },
    scope: { repositoryId: 'repo-x', workspaceId: 'ws-x', taskRef: 'task:t1', trellisTaskId: 't1', taskPath: null, association: 'resolved' },
    session: { parentId: 'p1', childId: null, runId: null },
    materials: [
      { source: '.trellis/tasks/a/prd.md', origin: 'file', outcome: 'included', reason: null, sourceBytes: 100, sourceDigest: digest('a'), includedBytes: 100, includedDigest: digest('a') },
      { source: '.trellis/spec/frontend/components.md', origin: 'file', outcome: 'truncated', reason: 'budget', sourceBytes: 4096, sourceDigest: digest('b'), includedBytes: 1024, includedDigest: digest('c') },
      { source: 'inline://workflow', origin: 'inline', outcome: 'included', reason: null, sourceBytes: null, sourceDigest: null, includedBytes: 64, includedDigest: digest('d') }
    ],
    totals: { expectedEntries: 4, recordedEntries: 3, omittedEntries: 1, contextUtf8Bytes: 2048, stdoutUtf8Bytes: null, budgetBytes: 8192, completeness: 'partial' },
    outputDigest: null,
    diagnosticCode: null,
    ...over
  }
}
const mkItem = (over = {}, itemOver = {}) => {
  const event = mkEvent(over)
  return { seq: evtSeq, eventId: event.eventId, injectionId: event.injectionId, kind: event.kind, occurredAtMs: event.occurredAtMs, receivedAtMs: event.occurredAtMs + 5, event, ...itemOver }
}

/* ---------------- 1) ReceiptProjection ---------------- */

/* ① 配对：assembled + emitted → level=emitted，paired=true */
{
  const items = [mkItem({ kind: 'context.assembled' }), mkItem({ kind: 'context.emitted', outputDigest: digest('e'), totals: { expectedEntries: 4, recordedEntries: 3, omittedEntries: 1, contextUtf8Bytes: 2048, stdoutUtf8Bytes: 2300, budgetBytes: 8192, completeness: 'partial' } })]
  const r = projectReceipts(items)
  check('配对 assembled+emitted → emitted 且 paired', r.receipts.length === 1 && r.receipts[0].level === 'emitted' && r.receipts[0].paired === true)
  check('配对时汇总取 emitted 口径（stdout 字节）', r.receipts[0].totals.stdoutUtf8Bytes === 2300 && r.receipts[0].outputDigest === digest('e'))
  check('partial 清单透出遗漏数', r.receipts[0].manifestIncomplete === true && r.receipts[0].totals.omittedEntries === 1)
}

/* ② 仅 emitted：完整证据（assembled 丢失不使其消失） */
{
  const items = [mkItem({ kind: 'context.emitted' })]
  const r = projectReceipts(items)
  check('仅 emitted → emitted 且非配对（仍完整证据）', r.receipts[0].level === 'emitted' && r.receipts[0].paired === false && r.receipts[0].assembledAtMs === null)
}

/* ③ 仅 assembled → 证据到「已组装」 */
{
  const items = [mkItem({ kind: 'context.assembled' })]
  const r = projectReceipts(items)
  check('仅 assembled → assembled', r.receipts[0].level === 'assembled' && r.receipts[0].emittedAtMs === null)
}

/* ④ 无记录 → unobserved（≠故障） */
{
  const r = projectReceipts([])
  check('无记录 → unobserved=true', r.unobserved === true && r.receipts.length === 0)
  check('未观察到措辞中性（不标失败）', EVIDENCE_UNOBSERVED.tone === 'l0' && EVIDENCE_UNOBSERVED.label === '未观察到')
}

/* ⑤ output_failed：输出失败事实（与 assembled 并存仍按失败呈现） */
{
  const only = projectReceipts([mkItem({ kind: 'context.output_failed', diagnosticCode: 'stdout_write_failed' })])
  check('仅 output_failed → 输出失败事实', only.receipts[0].level === 'output_failed' && only.receipts[0].diagnosticCode === 'stdout_write_failed')
  const both = projectReceipts([mkItem({ kind: 'context.assembled' }), mkItem({ kind: 'context.output_failed' })])
  check('assembled+output_failed → 仍按输出失败呈现', both.receipts[0].level === 'output_failed')
}

/* ⑥ 材料当时摘要与当前文件核对：same / changed / unverifiable / not_checked */
{
  const items = [mkItem({ kind: 'context.emitted' })]
  const current = {
    '.trellis/tasks/a/prd.md': digest('a').slice(0, 16), /* documents 层 revision 为前 16 hex */
    '.trellis/spec/frontend/components.md': digest('f'),
    'inline://workflow': null
  }
  const r = projectReceipts(items, current)
  const bySrc = Object.fromEntries(r.receipts[0].materials.map((x) => [x.source, x]))
  check('前缀一致 → same（16hex revision vs 64hex digest 可比前缀）', bySrc['.trellis/tasks/a/prd.md'].currency === 'same')
  check('摘要不一致 → changed', bySrc['.trellis/spec/frontend/components.md'].currency === 'changed')
  check('当时无 sourceDigest + 当前不可比 → unverifiable', bySrc['inline://workflow'].currency === 'unverifiable')
  const unchecked = projectReceipts(items)
  check('未提供核对表 → not_checked', Object.values(unchecked.receipts[0].materials).every((x) => x.currency === 'not_checked'))
  const nullDigest = projectReceipts(items, { '.trellis/tasks/a/prd.md': null })
  check('当前读不到 → unverifiable（无法核对）', nullDigest.receipts[0].materials[0].currency === 'unverifiable')
}

/* ⑦ eventId 重复输入去重（同 ID 取大 seq） */
{
  const a = mkItem({ kind: 'context.assembled' })
  const dup = { ...a, seq: a.seq, event: { ...a.event } }
  const r = projectReceipts([a, dup])
  check('重复 eventId 去重为单事实', r.totalEvents === 1 && r.receipts.length === 1)
}

/* ⑧ 多 injectionId 分组 + 时间倒序 */
{
  const older = mkItem({ injectionId: 'inj-old', occurredAtMs: 1760171000000 })
  const newer = mkItem({ injectionId: 'inj-new', occurredAtMs: 1760179000000 })
  const r = projectReceipts([older, newer])
  check('按 injectionId 分组且新的在前', r.receipts.length === 2 && r.receipts[0].injectionId === 'inj-new')
}

/* ⑨ 明细被 64KiB 预算删减：materials 空但遗漏数在汇总 */
{
  const assembled = mkItem({ kind: 'context.assembled', materials: [{ source: 'x.md', origin: 'file', outcome: 'included', reason: null, sourceBytes: 10, sourceDigest: digest('1'), includedBytes: 10, includedDigest: digest('1') }], totals: { expectedEntries: 4, recordedEntries: 1, omittedEntries: 3, contextUtf8Bytes: 100, stdoutUtf8Bytes: null, budgetBytes: null, completeness: 'partial' } })
  const emittedTrimmed = mkItem({ kind: 'context.emitted', materials: [], totals: { expectedEntries: 4, recordedEntries: 0, omittedEntries: 4, contextUtf8Bytes: 100, stdoutUtf8Bytes: 120, budgetBytes: null, completeness: 'partial' } })
  const r = projectReceipts([assembled, emittedTrimmed])
  check('emitted 明细删减时回退 assembled 明细', r.receipts[0].materials.length === 1 && r.receipts[0].materials[0].source === 'x.md')
  const r2 = projectReceipts([emittedTrimmed])
  check('仅删减事件 → 明细空但遗漏数透出', r2.receipts[0].materials.length === 0 && r2.receipts[0].manifestIncomplete === true && r2.receipts[0].totals.omittedEntries === 4)
}

/* ⑩ 措辞红线：上限「已输出至宿主通道」；禁止「已注入模型/已遵守」 */
{
  const all = ['emitted', 'assembled', 'output_failed'].map((k) => evidenceWording(k).label).join('|') + '|' + EVIDENCE_UNOBSERVED.label
  check('措辞含「已输出至宿主通道」', all.includes('已输出至宿主通道'))
  check('措辞不出现「已注入」或「已遵守」', !all.includes('已注入') && !all.includes('已遵守'))
  check('emitted 补充说明明确「尚无宿主接收确认」', evidenceWording('emitted').hint.includes('尚无宿主接收确认'))
  check('材料结果文案五态齐备', MATERIAL_OUTCOME_LABELS.included === '完整纳入' && MATERIAL_OUTCOME_LABELS.index_only === '仅索引' && MATERIAL_OUTCOME_LABELS.missing === '缺失')
}

/* ---------------- 2) ActivityProjection ---------------- */

/* ⑪ 四列分列 + 同 id 跨来源不合并 */
{
  const events = [
    { id: 'same-1', atMs: 1000, source: 'file', text: '文件变化事实', taskDir: 'a' },
    { id: 'same-1', atMs: 1001, source: 'timeline', text: '时间线事实', taskDir: 'a' },
    { id: 'unattr', atMs: 1002, source: 'timeline', text: '未归属事件', taskDir: null },
    { id: 'other-task', atMs: 1003, source: 'file', text: '别的任务', taskDir: 'b' }
  ]
  const r = projectActivity({ taskRecord: { status: 'in_progress', updatedAtMs: 900 }, events, archive: { archived: false, repoRelativeDir: '.trellis/tasks/a' }, taskDir: 'a' })
  const col = (k) => r.columns.find((c) => c.key === k)
  check('四列分列（task-record/files/timeline/archive）', r.columns.map((c) => c.key).join(',') === 'task-record,files,timeline,archive')
  check('同 id 跨来源不合并为同一事实', col('files').entries.some((e) => e.key === 'file:same-1') && col('timeline').entries.some((e) => e.key === 'timeline:same-1'))
  check('未归属事件不进任务视图（不借选中任务补全）', !col('timeline').entries.some((e) => e.text === '未归属事件'))
  check('其他任务事件不串线', !col('files').entries.some((e) => e.text === '别的任务'))
  check('归档列显示实际目录（未归档=活跃）', col('archive').entries[0].text.includes('活跃任务目录：.trellis/tasks/a'))
  /* 会话视图（taskDir=null）：全部显示且归属随条目透出 */
  const r2 = projectActivity({ taskRecord: null, events, archive: { archived: true, repoRelativeDir: '.trellis/tasks/archive/2026-10/a' }, taskDir: null })
  const t2 = r2.columns.find((c) => c.key === 'timeline')
  check('会话视图显示未归属条目并标记', t2.entries.some((e) => e.text === '未归属事件' && e.taskDir === null))
  check('归档视图显示归档目录', r2.columns.find((c) => c.key === 'archive').entries[0].text.includes('.trellis/tasks/archive/2026-10/a'))
  check('taskRecord=null 时不显示任务记录列内容', r2.columns.find((c) => c.key === 'task-record').entries.length === 0)
}

/* ⑫ 任务原始状态原值显示；不生成阶段完成链 */
{
  const r = projectActivity({ taskRecord: { status: 'custom_review_x', updatedAtMs: null }, events: [], archive: { archived: false, repoRelativeDir: '.trellis/tasks/a' }, taskDir: 'a' })
  const rec = r.columns.find((c) => c.key === 'task-record')
  check('自定义状态原值显示', rec.entries[0].text === 'custom_review_x')
  check('不出现阶段完成/耗时推导', !JSON.stringify(r).includes('完成阶段') && !JSON.stringify(r).includes('duration'))
  const r2 = projectActivity({ taskRecord: { status: null, updatedAtMs: null }, events: [], archive: { archived: false, repoRelativeDir: null }, taskDir: 'a' })
  check('状态缺失 → 如实「未知」', r2.columns.find((c) => c.key === 'task-record').entries[0].text.includes('未知'))
}

/* ⑬ 列内时间倒序 + 上限截断 */
{
  const events = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, atMs: i, source: 'file', text: `ev${i}`, taskDir: 'a' }))
  const r = projectActivity({ taskRecord: null, events, archive: { archived: false, repoRelativeDir: null }, taskDir: null })
  const files = r.columns.find((c) => c.key === 'files').entries
  check('列内时间倒序', files[0].atMs >= files[1].atMs && files[0].text === 'ev39')
  check('列内条目上限 30（有界）', files.length === 30)
}

/* ---------------- 3) observationHealthView（未知 ≠ 故障） ---------------- */

{
  const mk = (state, pauseReason = null) => observationHealthView({ state, pauseReason, dbVersion: 1, storeEpoch: 'e', logicalCount: 0, logicalPayloadBytes: 0, physicalBytes: 0, controlState: 'active' })
  check('active → ok', mk('active').tone === 'ok')
  check('paused(collection_disabled) → 中性（禁用不是故障）', mk('paused', 'collection_disabled').tone === 'neutral')
  check('paused(quota_retention) → 提示级（可恢复存储事实）', mk('paused', 'quota_retention').tone === 'warn' && mk('paused', 'quota_retention').label === '已暂停')
  check('corrupted → 错误（明确存储异常才红）', mk('corrupted').tone === 'error')
  check('future_version → 提示级不兼容', mk('future_version').tone === 'warn')
  check('not_initialized / closed → 中性（未知 ≠ 故障）', mk('not_initialized').tone === 'neutral' && mk('closed').tone === 'neutral')
}

rmSync(workDir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`receipt-projection smoke: ${failures} 项失败`)
  process.exit(1)
}
console.log('receipt-projection smoke: 全部通过')
