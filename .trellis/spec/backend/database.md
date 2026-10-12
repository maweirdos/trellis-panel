# Database Guidelines (Drizzle + SQLite)

> Guidelines for Drizzle ORM and SQLite development in Electron.

---

## Scenario: 内置 SQLite 双生产者（观测/控制存储，D-SQLITE 登记于 cockpit-s0）

### 1. Scope / Trigger

本文档其余部分（Drizzle + better-sqlite3 + WAL）是**ORM 引入后的参考指导**——当前 `package.json` 并未安装这些依赖。已落地的存储是 S0 观测/控制库（`.trellis/.panel/runtime/*.sqlite`），采用 Node 内置 `node:sqlite`（Electron worker）+ Python 标准库 `sqlite3`（Hook 子进程）双生产者。打包（asar）环境验证尚未完成；通过后本节升级为正式约定。

### 2. Signatures

- Panel 侧（唯一建库/迁移方）：`new DatabaseSync(path)`（专用 worker 内），`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL`。
- Hook 侧（只写已存在的库）：`sqlite3.connect(f"file:{db}?mode=rw", uri=True, timeout=0.005, isolation_level=None)`；`BEGIN IMMEDIATE` → 参数化 INSERT → `COMMIT`；**不做建库/迁移/清理/循环重试**。

### 3. Contracts

- 事件表核心列：`seq INTEGER PRIMARY KEY AUTOINCREMENT`（单调不复用）、`eventId TEXT UNIQUE`、`payloadDigest`、`injectionId`（索引）、`occurredAtMs INTEGER`（Unix 毫秒，见 shared/timestamp.md）。
- 双库分离：`observations.sqlite`（可禁用/清理/损坏重建）与 `control.sqlite`（任务恢复记录，观测清理不得触碰）独立版本/连接/事务，不假装跨库原子。

### 4. Validation & Error Matrix

- commit 前进程死亡 → 无脏行（journal 回滚），已实测
- 锁等待 5ms 耗尽 → Hook 立即失败退出，**不重试、不影响 hook 正常输出**，已实测
- 同 eventId 同 payloadDigest → 幂等（事务内 SELECT 判重后跳过，计数不增）；同 eventId 异 digest → 唯一约束拒绝并留冲突诊断（不用 INSERT OR IGNORE——无法区分冲突，见 §7）
- 库损坏 → 停写并显示不可用，保留原文件由用户选择重建；**不自动删除**

### 5. Good/Base/Bad Cases

- Good：Panel worker 批量查询 + Python 短事务插入，互不阻塞超过锁预算。
- Base：Python 写入失败（锁/满）→ 回执缺失记为缺证据，界面显示"未观察到"。
- Bad（禁止）：为规避锁把 emitted 记录提前到 stdout 写之前；用 `journal_mode=WAL` "顺手调优"（S0 明确不做，须先过兼容矩阵）。

### 6. Tests Required

- 跨进程探针（`.trellis/tasks/10-11-cockpit-s0-glass-box/research/spike/g1b-cross-process.mjs`）：崩溃无脏行/锁预算/幂等/seq 单调，12 项断言。
- Hook 生产者冒烟（`scripts/smoke/hook-emitter.mjs`，G1-C）：stdout 与 git HEAD 逐字节一致（sha256）、assembled/emitted 配对、故障矩阵（binding 缺失/TRELLIS_RECEIPTS=off/库只读/库损坏/stdout 提前关闭/序列化注入/身份不符）。
- 待补：打包 asar 内 worker 加载、Electron 主进程同进程并发、迁移/损坏矩阵（G3）。

### 7. Wrong vs Correct

#### Wrong

```python
conn = sqlite3.connect(db_path)          # 可能隐式建库；timeout 默认 5s 阻塞 hook
conn.execute(f"INSERT ... '{event_id}'")  # 字符串拼接 SQL
# 只插 6 列的简化示例：与落地 events 表不兼容（repositoryId/workspaceId/
# receivedAtMs/payloadBytes/payload 均 NOT NULL，见 store-core OBS_SCHEMA_V1）
conn.execute("INSERT INTO events(eventId, payloadDigest, injectionId, kind, occurredAtMs, payload) VALUES(?,?,?,?,?,?)", ...)
```

#### Correct

```python
# 列集与 store-core OBS_SCHEMA_V1 的 events 表完全一致（P3-a 修正：非空列全填）
conn = sqlite3.connect(f"file:{db_path}?mode=rw", uri=True, timeout=0.005, isolation_level=None)
conn.execute("BEGIN IMMEDIATE")
usage = conn.execute("SELECT logicalCount, logicalPayloadBytes FROM store_usage WHERE id=1").fetchone()
if usage is None:                      # 非 Panel 建的库/被篡改 → 放弃，不猜
    conn.execute("ROLLBACK")
# 事务内配额检查（满额暂停新增）与重复判定（不用 INSERT OR IGNORE——无法区分
# 同 eventId 同 digest 幂等与异 digest 冲突；Panel 侧是 SELECT-then-INSERT）
existing = conn.execute("SELECT payloadDigest FROM events WHERE eventId=?", (event_id,)).fetchone()
if existing is not None:               # 保留首见，不覆盖不重计
    conn.execute("ROLLBACK")
conn.execute(
    "INSERT INTO events(eventId, payloadDigest, injectionId, kind, repositoryId, workspaceId,"
    " taskRef, occurredAtMs, receivedAtMs, payloadBytes, payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    (event_id, digest, injection_id, kind, repo_id, ws_id, task_ref,
     occurred_ms, received_ms, payload_bytes, payload_json),
)
# 事件 INSERT 与 store_usage 变更同一事务提交（design §4.2）
conn.execute(
    "UPDATE store_usage SET logicalCount=logicalCount+1,"
    " logicalPayloadBytes=logicalPayloadBytes+?, updatedAtMs=? WHERE id=1",
    (payload_bytes, now_ms),
)
conn.execute("COMMIT")
# 任何失败：ROLLBACK → close → 退出（不重试）；payloadDigest = SHA-256(stableStringify(event))，
# 与 TS 侧 stableStringify 跨语言一致（黄金夹具 scripts/fixtures/observability/python-produced-*.json）
```

---


## Drizzle Client Setup

```typescript
// src/main/db/client.ts
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import * as schema from './schema';

const getDbPath = () => {
  if (process.env.NODE_ENV === 'development') {
    return './app-dev.db';
  }
  return path.join(app.getPath('userData'), 'app.db');
};

const sqlite = new Database(getDbPath());
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
export { sqlite };
```

---

## Schema Definition

```typescript
// src/main/db/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { relations, sql } from 'drizzle-orm';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status', { enum: ['active', 'archived', 'draft'] })
    .default('active')
    .notNull(),
  // Use timestamp_ms for millisecond precision
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
    .$onUpdate(() => new Date()),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// Relations for db.query.* API
export const projectsRelations = relations(projects, ({ many }) => ({
  tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  project: one(projects, {
    fields: [tasks.projectId],
    references: [projects.id],
  }),
}));

// Export types
export type Project = typeof projects.$inferSelect;
export type InsertProject = typeof projects.$inferInsert;
```

---

## Timestamp Precision

**CRITICAL: Always use `{ mode: 'timestamp_ms' }` for timestamps.**

```typescript
// BAD: Using seconds mode
createdAt: integer('createdAt', { mode: 'timestamp' }); // Stores 1734019200

// GOOD: Using milliseconds mode
createdAt: integer('createdAt', { mode: 'timestamp_ms' }); // Stores 1734019200000
```

---

## Query Patterns

```typescript
// Single result
const user = db.select().from(users).where(eq(users.id, id)).get();

// Multiple results
const allUsers = db.select().from(users).all();

// Insert with return
const newUser = db.insert(users).values(data).returning().get();

// Relational queries
const projectsWithTasks = db.query.projects.findMany({
  with: { tasks: true },
});

// Transaction
db.transaction((tx) => {
  tx.insert(projects).values(projectData).run();
  tx.insert(tasks).values(taskData).run();
});

// Batch lookup (avoid N+1)
const results = db.select().from(items).where(inArray(items.id, ids)).all();
```

---

## Migrations

```typescript
// src/main/db/migrate.ts
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './client';
import { existsSync } from 'fs';
import path from 'path';

export function runMigrations() {
  const migrationsFolder =
    process.env.NODE_ENV === 'development'
      ? path.resolve(__dirname, '..', '..', 'drizzle')
      : path.join(process.resourcesPath, 'drizzle');

  if (!existsSync(migrationsFolder)) {
    return { success: false, reason: 'missing-folder' };
  }

  try {
    migrate(db, { migrationsFolder });
    return { success: true };
  } catch (error) {
    return { success: false, reason: 'error', error: error.message };
  }
}
```

---

## Quick Reference

| Operation     | Method                  |
| ------------- | ----------------------- |
| Single        | `.get()`                |
| Multiple      | `.all()`                |
| Insert/Update | `.run()`                |
| With return   | `.returning().get()`    |
| Relational    | `db.query.*.findMany()` |

| Rule               | Reason                |
| ------------------ | --------------------- |
| Use `timestamp_ms` | Match JavaScript Date |
| Use transactions   | Atomic operations     |
| Use `inArray`      | Avoid N+1 queries     |
| Filter `isDeleted` | Exclude soft-deleted  |
