"""G1-B spike: Python 写入者在 commit 前被硬杀（os._exit）。

用法: python g1b_crash.py <db_path> <event_id>
退出码 7 = 已插入未提交即被杀（父进程据此验证无脏行）。
"""
import os
import sys

import sqlite3

db_path, event_id = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(f"file:{db_path}?mode=rw", uri=True, timeout=0.005, isolation_level=None)
conn.execute("PRAGMA journal_mode=DELETE")
conn.execute("PRAGMA synchronous=FULL")
conn.execute("BEGIN IMMEDIATE")
conn.execute(
    "INSERT INTO events(eventId, payloadDigest, injectionId, kind, occurredAtMs, payload) VALUES(?,?,?,?,?,?)",
    (event_id, "d" * 64, "i1", "context.assembled", 1760172000000, "{}"),
)
# 故意不 commit：模拟进程在事务中途死亡
sys.stderr.write("crash-before-commit\n")
os._exit(7)
