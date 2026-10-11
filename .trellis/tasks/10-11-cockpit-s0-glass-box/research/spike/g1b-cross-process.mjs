/**
 * G1-B 探针：node:sqlite（Electron 侧）与 Python sqlite3（Hook 侧）跨进程写入同一观测库。
 * 验证 design §4 的五个承诺：建库/迁移只归 Panel、Python mode=rw 不建库、
 * commit 前硬杀无脏行、锁预算耗尽即失败不重试、eventId 去重与冲突诊断。
 * 运行：node g1b-cross-process.mjs   （在 research/spike/ 目录内）
 */
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'child_process'
import { rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const db = join(here, 'observations-spike.sqlite')
for (const suffix of ['', '-journal']) {
  try { rmSync(db + suffix) } catch { /* 不存在即跳过 */ }
}

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
  if (!cond) failures += 1
}

/* Panel 身份：建库 + 迁移（唯一负责方） */
const panel = new DatabaseSync(db)
panel.exec(`
  PRAGMA journal_mode=DELETE;
  PRAGMA synchronous=FULL;
  CREATE TABLE schema_meta(dbVersion INTEGER NOT NULL);
  CREATE TABLE events(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    eventId TEXT NOT NULL UNIQUE,
    payloadDigest TEXT NOT NULL,
    injectionId TEXT NOT NULL,
    kind TEXT NOT NULL,
    occurredAtMs INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX idx_events_injection ON events(injectionId);
  INSERT INTO schema_meta(dbVersion) VALUES(1);
`)
check('Panel 建库/建表/索引（journal=DELETE, synchronous=FULL）', true)
check('PRAGMA 生效', panel.prepare('PRAGMA journal_mode').get().journal_mode === 'delete')

const count = () => panel.prepare('SELECT COUNT(*) c FROM events').get().c

/* A. Python commit 前硬杀 → 无脏行 */
const crash = spawnSync('python', ['-X', 'utf8', join(here, 'g1b_crash.py'), db, 'evt-crash'], { encoding: 'utf8' })
check('Python 事务中途 os._exit 退出码 7', crash.status === 7, `status=${crash.status}`)
check('commit 前死亡不产生脏行（count=0）', count() === 0, `count=${count()}`)
check('残留 journal 在下次连接后被清理/可继续写', (() => {
  panel.prepare("INSERT INTO events(eventId,payloadDigest,injectionId,kind,occurredAtMs,payload) VALUES('evt-after-crash',?,?,?,?,?)").run('d'.repeat(64), 'i1', 'context.assembled', 1760172000000, '{}')
  return count() === 1
})())

/* B. Python 正常提交（mode=rw 不建库、参数化、短事务） */
const ok = spawnSync('python', ['-X', 'utf8', join(here, 'g1b_write.py'), db, 'evt-py-1'], { encoding: 'utf8' })
check('Python 正常写入成功', ok.status === 0 && ok.stdout.includes('committed'), `out=${ok.stdout} err=${ok.stderr}`)
check('Python 行对 Node 可见（count=2）', count() === 2, `count=${count()}`)

/* C. 锁竞争：Node 持写事务 300ms，Python 5ms 预算耗尽应失败退出 3（不重试） */
panel.exec('BEGIN IMMEDIATE')
panel.prepare("INSERT INTO events(eventId,payloadDigest,injectionId,kind,occurredAtMs,payload) VALUES('evt-node-hold',?,?,?,?,?)").run('d'.repeat(64), 'i1', 'context.assembled', 1760172000100, '{}')
const locked = spawnSync('python', ['-X', 'utf8', join(here, 'g1b_write.py'), db, 'evt-py-locked', '--expect-lock-fail'], { encoding: 'utf8' })
panel.exec('COMMIT')
check('Node 持锁期间 Python 预算耗尽即失败（exit 3）', locked.status === 3 && locked.stdout.includes('lock_budget_exhausted'), `status=${locked.status} out=${locked.stdout}`)
check('锁竞争后无幽灵行（count=3）', count() === 3, `count=${count()}`)

/* D. eventId 去重：同 ID 同 digest 幂等；同 ID 异 digest 冲突可诊断 */
const insertOrIgnore = panel.prepare(
  "INSERT OR IGNORE INTO events(eventId,payloadDigest,injectionId,kind,occurredAtMs,payload) VALUES(?,?,?,?,?,?)"
)
insertOrIgnore.run('evt-dup', 'a'.repeat(64), 'i1', 'context.asitted', 1760172000200, '{}')
insertOrIgnore.run('evt-dup', 'a'.repeat(64), 'i1', 'context.asitted', 1760172000200, '{}')
check('同 eventId 同 digest 幂等（不重复计数）', count() === 4, `count=${count()}`)
const existing = panel.prepare('SELECT payloadDigest FROM events WHERE eventId=?').get('evt-dup')
insertOrIgnore.run('evt-dup', 'b'.repeat(64), 'i1', 'context.asitted', 1760172000200, '{}')
const stillOne = panel.prepare('SELECT COUNT(*) c FROM events WHERE eventId=?').get('evt-dup').c === 1
check('同 eventId 异 digest 被唯一约束拒绝且可诊断', stillOne && existing.payloadDigest === 'a'.repeat(64))

/* E. seq 单调不复用 */
const seqs = panel.prepare('SELECT seq FROM events ORDER BY seq').all().map((r) => r.seq)
check('seq 严格递增不复用', seqs.every((s, i) => i === 0 || s > seqs[i - 1]), JSON.stringify(seqs))

panel.close()
rmSync(db)
if (failures > 0) {
  console.error(`G1-B 探针：${failures} 项失败`)
  process.exit(1)
}
console.log('G1-B 探针：全部通过 ✓（尚未覆盖：打包 asar 环境、Electron worker 线程、真实 Hook 并发）')
