"""G1-B spike: Python 正常写入（design §4.2 的 Hook 生产者行为）。

用法: python g1b_write.py <db_path> <event_id> [--expect-lock-fail]
- 默认：短事务插入一条事件，成功退出 0。
- --expect-lock-fail：锁等待预算 5ms 用尽即失败退出 3（不循环重试）。
"""
import sqlite3
import sys

db_path, event_id = sys.argv[1], sys.argv[2]
expect_lock_fail = "--expect-lock-fail" in sys.argv

conn = sqlite3.connect(f"file:{db_path}?mode=rw", uri=True, timeout=0.005, isolation_level=None)
try:
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("BEGIN IMMEDIATE")
    conn.execute(
        "INSERT INTO events(eventId, payloadDigest, injectionId, kind, occurredAtMs, payload) VALUES(?,?,?,?,?,?)",
        (event_id, "d" * 64, "i1", "context.emitted", 1760172000090, "{}"),
    )
    conn.execute("COMMIT")
    print("committed")
except sqlite3.OperationalError as err:
    if expect_lock_fail and "locked" in str(err):
        print("lock_budget_exhausted")
        sys.exit(3)
    raise
finally:
    conn.close()
