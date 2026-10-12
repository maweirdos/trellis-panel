#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Observability receipt emitter（cockpit S0 · G1-A/C 本地实验片）。

为 inject-subagent-context.py 提供上下文组装/输出回执（design §3/§4.2，PRD FR2/AC3）：
- 事件契约与 src/shared/observability/schema.ts 的 ContextEventV1 严格对齐；
  digest 口径（stableStringify：递归键排序 UTF-8 JSON + SHA-256 hex）跨语言一致，
  由 scripts/fixtures/observability/python-produced-*.json 黄金夹具证明。
- 时机（design §3.3）：组装完成记 context.assembled；stdout write+flush 成功后记
  context.emitted；序列化/输出报错尽力记 context.output_failed。禁止提前记成功。
- 写入遵循 D-SQLITE Python 约定（backend/database.md）：只写已存在的库
  （file:...?mode=rw、timeout=0.005、BEGIN IMMEDIATE、参数化、失败 rollback/close
  退出、不建库不迁移不清理不循环重试）；事件 INSERT 与 store_usage 变更同一事务。

安全边界（最高优先级）：
- 本模块任何失败绝不影响宿主 hook 的 stdout 内容、退出码与既有行为；每次写入
  失败最多输出一行 stderr（不含绝对路径）。
- TRELLIS_RECEIPTS=off 全局旁路；binding.json 不存在时一次 stat 即返回（零额外
  开销路径，不安装采集包装、不读任何其他文件）。
- 身份规则与 src/main/services/observability/identity.ts 相同：读
  %LOCALAPPDATA%/TrellisPanel/installation.json 与 <root>/.trellis/.panel/runtime/
  binding.json；installationId/canonical root 不符或缺失 → 跳过（不采集）。

仅本地实验：本文件随 .codex/hooks 生成副本一起修改，不构成团队分发（design §8）。
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
import time
import uuid
from pathlib import Path

SCHEMA_VERSION = 1

# 与 src/shared/observability/store.ts 的试验初值一致（design §4.3）
EVENT_ENCODE_LIMIT_BYTES = 64 * 1024
RETENTION_MAX_EVENTS = 50_000
RETENTION_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024
PHYSICAL_SOFT_LIMIT_BYTES = 128 * 1024 * 1024

DB_TIMEOUT_SECONDS = 0.005
# 材料原字节内存保留上限：超限后只保留 length/digest（included 摘要改由输出块
# 文本反推），避免长会话材料把 hook 内存撑大。仅观测启用路径生效。
RETAINED_BYTES_CAP = 1024 * 1024
JSON_READ_LIMIT = 64 * 1024
SESSION_ID_MAX_CHARS = 128

_json_dumps = json.dumps  # 故障注入开关改写 json.dumps 前的私有引用

# ---------------- 基础工具 ----------------


def _now_ms() -> int:
    # shared/timestamp.md：Unix 毫秒，一律 time.time_ns()//1_000_000
    return time.time_ns() // 1_000_000


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _utf8_len(text: str) -> int:
    return len(text.encode("utf-8"))


def stable_stringify(value: object) -> str:
    """与 TS store-core stableStringify 跨语言一致的稳定序列化。

    口径：递归键排序（UTF-16 码元序，等价 JS Array.prototype.sort 默认序）、
    紧凑分隔符、非 ASCII 原样输出（ensure_ascii=False）、整数十进制。
    跨语言一致性由黄金夹具证明（known-issues P3-b 偿还）。
    """
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _json_dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        # 契约字段均为整数毫秒/字节；防御路径：非有限值不可序列化，
        # 整数值浮点按 JS Number 字符串化（同型），其余取 repr。
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError("non-finite float is not serializable")
        if value.is_integer() and abs(value) < 1e21:
            return str(int(value))
        return repr(value)
    if isinstance(value, list):
        return "[" + ",".join(stable_stringify(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=lambda k: k.encode("utf-16-be", "surrogatepass"))
        return (
            "{"
            + ",".join(
                _json_dumps(k, ensure_ascii=False) + ":" + stable_stringify(value[k])
                for k in keys
            )
            + "}"
        )
    raise TypeError(f"unsupported type for stable stringify: {type(value)!r}")


def _read_json_bounded(path: Path, limit: int = JSON_READ_LIMIT) -> object | None:
    try:
        raw = path.read_bytes()[:limit]
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def _installation_dir() -> Path:
    # 与 identity.ts installationDir() 相同的固定规则：Windows 首发 %LOCALAPPDATA%，
    # 其余平台回退 XDG 风格；不接受仓库内容提供任意路径。
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "TrellisPanel"
    return Path.home() / ".local" / "share" / "TrellisPanel"


def _canonical_root(root: str) -> str:
    try:
        return str(Path(root).resolve())
    except Exception:
        return os.path.abspath(root)


def _same_root(a: str, b: str) -> bool:
    # 镜像 identity.ts sameRoot：Windows 盘符/大小写不敏感；其余平台严格相等
    if a == b:
        return True
    if os.name != "nt":
        return False
    na = "\\".join(p for p in a.replace("/", "\\").split("\\") if p).lower()
    nb = "\\".join(p for p in b.replace("/", "\\").split("\\") if p).lower()
    return na == nb


def _valid_installation(raw: object) -> bool:
    return (
        isinstance(raw, dict)
        and isinstance(raw.get("installationId"), str)
        and len(raw["installationId"]) >= 8
        and isinstance(raw.get("createdAtMs"), (int, float))
    )


def _valid_binding(raw: object) -> bool:
    # 与 identity.ts readBinding 相同的字段校验；缺失/非法 → None（不创建、不修复）
    return (
        isinstance(raw, dict)
        and isinstance(raw.get("installationId"), str)
        and isinstance(raw.get("repositoryId"), str)
        and bool(raw.get("repositoryId"))
        and isinstance(raw.get("workspaceId"), str)
        and bool(raw.get("workspaceId"))
        and isinstance(raw.get("canonicalRoot"), str)
        and bool(raw.get("canonicalRoot"))
        and isinstance(raw.get("collectionEnabled"), bool)
    )


_warned = False


def _warn(message: str) -> None:
    # 每个进程最多输出一行 stderr（首个写库失败；后续失败静默）；
    # 剥离本机绝对路径形态（镜像 store-core redactText）。
    global _warned
    if _warned:
        return
    _warned = True
    import re

    redacted = re.sub(r"[A-Za-z]:\\[^\s\"']*", "<path>", message)
    redacted = re.sub(r"/(?:[\w.-]+/)+", "<path>/", redacted)
    redacted = re.sub(r"[\x00-\x1f]", "", redacted)[:200]
    try:
        sys.stderr.write(f"[inject-subagent-context] observability: {redacted}\n")
    except Exception:
        pass


# ---------------- 采集包装（仅观测启用时安装；严格透传，异常自吞） ----------------

_read_records: list[dict] = []
_material_records: list[dict] = []
_retained_bytes_total = 0
_budget_bytes: int | None = None


def _record_read(base_path: str, file_path: str, data: bytes | None) -> None:
    global _retained_bytes_total
    record = {"file": str(file_path), "size": None, "digest": None, "bytes": None}
    if data is not None:
        record["size"] = len(data)
        record["digest"] = _sha256_hex(data)
        if _retained_bytes_total + len(data) <= RETAINED_BYTES_CAP:
            record["bytes"] = data
            _retained_bytes_total += len(data)
    _read_records.append(record)


# 与 inject-subagent-context._truncate_notice 逐字节相同的文案（含 em dash）
_TRUNCATE_NOTICE_FMT = "\n[Trellis: truncated at {cap} bytes — read {path} for the full content]"
_BINARY_NOTICE_PREFIX = "[Trellis: not inlined (binary file)"
_BUDGET_NOTICE_PREFIX = "[Trellis: not inlined (total context limit reached)"


def _record_materialized(
    base_path: str,
    file_path: str,
    cap: int,
    block: str | None,
) -> None:
    # 关联当次读取记录：单线程顺序调用，取最近一条未消费的同路径记录
    read_record = None
    for record in reversed(_read_records):
        if not record.get("_consumed") and record["file"] == file_path:
            read_record = record
            record["_consumed"] = True
            break

    source = str(file_path).replace("\\", "/")
    if block is None:
        # 读取拒绝/缺失：按目标是否存在区分 not_found / read_failed
        #（越界拒绝与读失败都表现为“存在但读不到”→ read_failed，如实不猜测）
        try:
            exists = os.path.exists(os.path.join(str(base_path), str(file_path)))
        except OSError:
            exists = None
        reason = "not_found" if exists is False else "read_failed"
        _material_records.append(
            _material(source, "file", "missing", reason, read_record, None, None)
        )
        return
    if block.startswith(_BINARY_NOTICE_PREFIX):
        _material_records.append(
            _material(source, "file", "index_only", "binary", read_record, None, None)
        )
        return
    if block.startswith(_BUDGET_NOTICE_PREFIX):
        _material_records.append(
            _material(source, "file", "index_only", "budget", read_record, None, None)
        )
        return
    # 常规内联块：`=== header ===\n<fragment>[truncation notice?]`
    idx = block.find("\n")
    fragment = block[idx + 1 :] if idx >= 0 else ""
    truncated = False
    notice = _TRUNCATE_NOTICE_FMT.format(cap=cap, path=file_path)
    if fragment.endswith(notice):
        fragment = fragment[: -len(notice)]
        truncated = True
    outcome = "truncated" if truncated else "included"
    reason = "budget" if truncated else None
    _material_records.append(
        _material(
            source,
            "file",
            outcome,
            reason,
            read_record,
            _utf8_len(fragment),
            _sha256_hex(fragment.encode("utf-8")),
        )
    )


def _material(
    source: str,
    origin: str,
    outcome: str,
    reason: str | None,
    read_record: dict | None,
    included_bytes: int | None,
    included_digest: str | None,
) -> dict:
    return {
        "source": source,
        "origin": origin,
        "outcome": outcome,
        "reason": reason,
        # 读不到/未读取/不适用为 null，不得填 0 暗示空文件（design §3.2）
        "sourceBytes": read_record["size"] if read_record else None,
        "sourceDigest": read_record["digest"] if read_record else None,
        "includedBytes": included_bytes,
        "includedDigest": included_digest,
    }


def _install_wrappers(hook_module: object) -> None:
    # 严格透传包装：先调原函数，记录失败自吞，绝不改变返回值与异常语义。
    orig_read = getattr(hook_module, "_read_file_bytes", None)
    orig_file = getattr(hook_module, "_materialize_file", None)
    orig_artifact = getattr(hook_module, "_materialize_artifact", None)
    if not callable(orig_read) or not callable(orig_file) or not callable(orig_artifact):
        raise RuntimeError("hook entrypoints not found")

    # 漂移防护（check P2-1）+ 现行调用零变化：命名参数绑定使未来上游的关键字
    # 调用/加参不再在绑定点抛 TypeError（那会破坏上下文组装）；记录取值带类型
    # 守卫，形态漂移只让观测降级为不记录，绝不影响返回值与异常语义。
    def _wrap_read(base_path=None, file_path=None, *extra, **kw):
        data = orig_read(base_path, file_path, *extra, **kw)
        try:
            if isinstance(file_path, str):
                _record_read(base_path, file_path, data)
        except Exception:
            pass
        return data

    def _wrap_file(base_path=None, file_path=None, reason=None, limits=None, budget=None, *extra, **kw):
        block = orig_file(base_path, file_path, reason, limits, budget, *extra, **kw)
        try:
            if isinstance(file_path, str) and isinstance(limits, dict):
                _note_budget(limits, budget)
                _record_materialized(base_path, file_path, int(limits["max_file_bytes"]), block)
        except Exception:
            pass
        return block

    def _wrap_artifact(base_path=None, file_path=None, header_label=None, reason=None, limits=None, budget=None, *extra, **kw):
        block = orig_artifact(base_path, file_path, header_label, reason, limits, budget, *extra, **kw)
        try:
            if isinstance(file_path, str) and isinstance(limits, dict):
                _note_budget(limits, budget)
                _record_materialized(base_path, file_path, int(limits["max_artifact_bytes"]), block)
        except Exception:
            pass
        return block

    setattr(hook_module, "_read_file_bytes", _wrap_read)
    setattr(hook_module, "_materialize_file", _wrap_file)
    setattr(hook_module, "_materialize_artifact", _wrap_artifact)


def _note_budget(limits, budget) -> None:
    global _budget_bytes
    if _budget_bytes is None:
        try:
            _budget_bytes = int(getattr(budget, "max_total_bytes", limits["max_total_bytes"]))
        except Exception:
            _budget_bytes = None


# ---------------- 身份与收集状态 ----------------

_collect: dict | None = None


def _resolve_identity(repo_root: str) -> dict | None:
    """按 identity.ts 固定规则校验；任何不符 → None（跳过，不采集）。"""
    if os.environ.get("TRELLIS_RECEIPTS") == "off":
        return None
    runtime_dir = Path(repo_root) / ".trellis" / ".panel" / "runtime"
    binding = _read_json_bounded(runtime_dir / "binding.json")
    if not _valid_binding(binding):
        return None
    installation = _read_json_bounded(_installation_dir() / "installation.json")
    if not _valid_installation(installation):
        return None
    if installation["installationId"] != binding["installationId"]:  # type: ignore[index]
        return None
    if not _same_root(str(binding["canonicalRoot"]), _canonical_root(str(repo_root))):  # type: ignore[index]
        return None
    if binding["collectionEnabled"] is not True:  # type: ignore[index]
        return None
    db_path = runtime_dir / "observations.sqlite"
    if not db_path.is_file():
        # Panel 是唯一建库方；库不存在 = 观测未就绪，不采集（design §4.2）
        return None
    return {"binding": binding, "db_path": str(db_path)}


def _task_identity(repo_root: str, task_dir: str | None) -> tuple[str | None, str | None, str | None, str]:
    if not task_dir:
        return (None, None, None, "unresolved")
    task_path = str(task_dir).replace("\\", "/").rstrip("/")
    task_ref = task_path.rsplit("/", 1)[-1] if task_path else None
    trellis_task_id = None
    if task_ref:
        raw = _read_json_bounded(Path(repo_root) / task_path / "task.json")
        if isinstance(raw, dict) and isinstance(raw.get("id"), str):
            trellis_task_id = raw["id"]
    return (task_ref, trellis_task_id, task_path, "resolved" if task_ref else "unresolved")


def _producer_version(repo_root: str) -> str:
    try:
        text = (Path(repo_root) / ".trellis" / ".version").read_text(encoding="utf-8")[:64]
        stripped = text.strip()
        return stripped or "unversioned"
    except Exception:
        return "unversioned"


def _extract_context_field(output: object) -> str | None:
    """提取实际输出的上下文字段（additionalContext / updatedInput.prompt 等）。"""
    if not isinstance(output, dict):
        return None
    specific = output.get("hookSpecificOutput")
    if isinstance(specific, dict):
        extra = specific.get("additionalContext")
        if isinstance(extra, str):
            return extra
        updated = specific.get("updatedInput")
        if isinstance(updated, dict) and isinstance(updated.get("prompt"), str):
            return updated["prompt"]
    for key in ("updated_input", "updatedInput"):
        value = output.get(key)
        if isinstance(value, dict) and isinstance(value.get("prompt"), str):
            return value["prompt"]
    return None


# ---------------- 事件编码与写库 ----------------


def _encode_event(event: dict) -> tuple[str | None, int, str | None]:
    """编码（含 64KiB 预算删减）；返回 (payload_json, payload_bytes, stable digest)。

    删减口径与 store-core trimEventForStore 一致：丢弃 materials 明细、遗漏数并入
    totals、完整性标 partial（not_applicable 保持）；汇总仍超限返回 (None, 0, None)
    表示跳过观测（不落半截数据）。
    """
    payload = _json_dumps(event, ensure_ascii=False, separators=(",", ":"))
    size = _utf8_len(payload)
    if size <= EVENT_ENCODE_LIMIT_BYTES:
        return payload, size, _sha256_hex(stable_stringify(event).encode("utf-8"))
    omitted = len(event.get("materials", []))
    trimmed = dict(event)
    trimmed["materials"] = []
    totals = dict(event["totals"])
    totals["omittedEntries"] = totals["omittedEntries"] + omitted
    if totals["completeness"] != "not_applicable":
        totals["completeness"] = "partial"
    trimmed["totals"] = totals
    payload = _json_dumps(trimmed, ensure_ascii=False, separators=(",", ":"))
    size = _utf8_len(payload)
    if size > EVENT_ENCODE_LIMIT_BYTES:
        return None, 0, None
    return payload, size, _sha256_hex(stable_stringify(trimmed).encode("utf-8"))


def _physical_bytes(db_path: str) -> int:
    total = 0
    for suffix in ("", "-journal", "-wal", "-shm"):
        try:
            stat = os.stat(db_path + suffix)
            if os.path.isfile(db_path + suffix):
                total += stat.st_size
        except OSError:
            continue
    return total


def _write_event(db_path: str, event: dict) -> bool:
    """D-SQLITE Python 约定写入；任何失败 rollback/close 退出，返回 False。"""
    payload, payload_bytes, _digest = _encode_event(event)
    if payload is None:
        return False
    if _physical_bytes(db_path) >= PHYSICAL_SOFT_LIMIT_BYTES:
        return False
    conn = None
    try:
        conn = sqlite3.connect(
            f"file:{db_path}?mode=rw",
            uri=True,
            timeout=DB_TIMEOUT_SECONDS,
            isolation_level=None,
        )
        conn.execute("BEGIN IMMEDIATE")
        usage = conn.execute(
            "SELECT logicalCount, logicalPayloadBytes FROM store_usage WHERE id=1"
        ).fetchone()
        if usage is None:
            conn.execute("ROLLBACK")
            _warn("event write skipped (store_usage missing)")
            return False
        if (
            int(usage[0]) >= RETENTION_MAX_EVENTS
            or int(usage[1]) + payload_bytes > RETENTION_MAX_PAYLOAD_BYTES
        ):
            # 逻辑配额满：静默暂停新增（design §4.3；Panel 侧健康视图呈现原因）
            conn.execute("ROLLBACK")
            return False
        existing = conn.execute(
            "SELECT payloadDigest FROM events WHERE eventId=?", (event["eventId"],)
        ).fetchone()
        if existing is not None:
            # 同 eventId：与 Panel 侧行为一致——保留首见，不覆盖不重计
            # （事务内 SELECT 先判，不用 INSERT OR IGNORE，见 known-issues P3）
            conn.execute("ROLLBACK")
            return False
        conn.execute(
            "INSERT INTO events(eventId, payloadDigest, injectionId, kind, repositoryId,"
            " workspaceId, taskRef, occurredAtMs, receivedAtMs, payloadBytes, payload)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                event["eventId"],
                _digest,
                event["injectionId"],
                event["kind"],
                event["scope"]["repositoryId"],
                event["scope"]["workspaceId"],
                event["scope"]["taskRef"],
                event["occurredAtMs"],
                _now_ms(),
                payload_bytes,
                payload,
            ),
        )
        conn.execute(
            "UPDATE store_usage SET logicalCount=logicalCount+1,"
            " logicalPayloadBytes=logicalPayloadBytes+?, updatedAtMs=? WHERE id=1",
            (payload_bytes, _now_ms()),
        )
        conn.execute("COMMIT")
        return True
    except Exception as exc:  # noqa: BLE001 — 任何写库失败都不得影响宿主
        if conn is not None:
            try:
                conn.execute("ROLLBACK")
            except Exception:
                pass
        message = str(exc)
        if not ("locked" in message or "busy" in message):
            # 锁竞争是预期路径（G1-B 已证 5ms 预算耗尽即失败）：静默；
            # 其余失败一行 stderr 供诊断（无绝对路径）。
            _warn(f"event write skipped ({type(exc).__name__}: {message})")
        return False
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def _build_event(collect: dict, kind: str, totals: dict, output_digest: str | None, diagnostic: str | None) -> dict:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "eventId": str(uuid.uuid4()),
        "injectionId": collect["injection_id"],
        "kind": kind,
        "occurredAtMs": _now_ms(),
        "producer": collect["producer"],
        "scope": collect["scope"],
        "session": collect["session"],
        "materials": collect["materials"],
        "totals": totals,
        "outputDigest": output_digest,
        "diagnosticCode": diagnostic,
    }


def _maybe_dump(kind: str, event: dict, digest: str | None, context_field: str | None) -> None:
    """测试用：TRELLIS_OBS_DUMP_DIR 指定时把真实产出落盘（黄金夹具捕获）。"""
    dump_dir = os.environ.get("TRELLIS_OBS_DUMP_DIR")
    if not dump_dir:
        return
    names = {
        "context.assembled": "python-produced-assembled.json",
        "context.emitted": "python-produced-emitted.json",
        "context.output_failed": "python-produced-output-failed.json",
    }
    wrapper: dict = {"kind": kind, "payloadDigest": digest, "event": event}
    if isinstance(context_field, str):
        wrapper["contextText"] = context_field
    target = Path(dump_dir) / names.get(kind, f"python-produced-{kind}.json")
    target.write_text(
        _json_dumps(wrapper, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


# ---------------- 对宿主 hook 暴露的三个时机点 ----------------


def note_assembled(
    repo_root: str,
    task_dir: str | None,
    agent_type: str,
    context: str,
    output: object,
    session_parent_id: str | None,
    producer_host: str,
) -> None:
    """读取与组装完成（design §3.3 步骤 1-2）：身份校验 + 尝试记 assembled。

    任何失败静默返回（最多一行 stderr），不阻止后续输出。即使本条写入失败，
    收集状态仍建立——emitted 必须能独立成立。
    """
    global _collect
    if _collect is not None:
        return
    # 包装器未装上（入口漂移）→ 材料捕获不可用：不落"materials=[] 却声称
    # complete"的事件（FR2：不以有记录代表被遵守；check P2-2）。
    if not _ARMED:
        return
    try:
        identity = _resolve_identity(repo_root)
        if identity is None:
            return
        binding = identity["binding"]
        task_ref, trellis_task_id, task_path, association = _task_identity(repo_root, task_dir)
        parent = (session_parent_id or "").strip()[:SESSION_ID_MAX_CHARS] or None
        materials = [dict(m) for m in _material_records]
        if not materials and context and str(agent_type).endswith("research"):
            # research 上下文为动态拼接段：登记为单一 inline 材料（design §3.2）
            materials.append(
                {
                    "source": "inline:spec-tree",
                    "origin": "inline",
                    "outcome": "included",
                    "reason": None,
                    "sourceBytes": None,
                    "sourceDigest": None,
                    "includedBytes": _utf8_len(context),
                    "includedDigest": _sha256_hex(context.encode("utf-8")),
                }
            )
        collect = {
            "injection_id": str(uuid.uuid4()),
            "db_path": identity["db_path"],
            "producer": {
                "host": (producer_host or "unknown").strip()[:64] or "unknown",
                "hook": "inject-subagent-context",
                "version": _producer_version(repo_root),
                "capability": "subagent-context-v1",
            },
            "scope": {
                "repositoryId": binding["repositoryId"],
                "workspaceId": binding["workspaceId"],
                "taskRef": task_ref,
                "trellisTaskId": trellis_task_id,
                "taskPath": task_path,
                "association": association,
            },
            "session": {"parentId": parent, "childId": None, "runId": None},
            "materials": materials,
            "totals": {
                # 预期材料条数：目录展开与动态段使精确预期不可得 → null（不计算缺失率）
                "expectedEntries": None,
                "recordedEntries": len(materials),
                "omittedEntries": 0,
                "contextUtf8Bytes": _utf8_len(context),
                "stdoutUtf8Bytes": None,
                "budgetBytes": _budget_bytes,
                "completeness": "complete",
            },
            "context_field": _extract_context_field(output),
        }
        event = _build_event(collect, "context.assembled", dict(collect["totals"]), None, None)
        _, _, digest = _encode_event(event)
        _write_event(collect["db_path"], event)
        _maybe_dump("context.assembled", event, digest, collect["context_field"])
        _collect = collect
    except Exception as exc:  # noqa: BLE001
        try:
            _warn(f"assembled receipt skipped ({type(exc).__name__})")
        except Exception:
            pass


def note_emitted(output: object) -> None:
    """stdout write+flush 成功后（design §3.3 步骤 4）：尝试记 emitted。

    含 outputDigest（实际输出上下文字段 UTF-8 的完整 SHA-256）与
    stdoutUtf8Bytes（宿主协议包装整体字节，含 print 追加的换行）。
    """
    collect = _collect
    if collect is None:
        return
    try:
        line = _json_dumps(output, ensure_ascii=False)
        # print 在文本模式 stdout 上做换行翻译（Windows → \r\n），协议包装字节
        # 按 os.linesep 实际写出宽度计（POSIX 为 \n，宽度 1，公式同型）。
        stdout_bytes = _utf8_len(line) + len(os.linesep.encode("utf-8"))
        context_field = collect["context_field"]
        output_digest = (
            _sha256_hex(context_field.encode("utf-8")) if isinstance(context_field, str) else None
        )
        totals = dict(collect["totals"], stdoutUtf8Bytes=stdout_bytes)
        event = _build_event(collect, "context.emitted", totals, output_digest, None)
        _, _, digest = _encode_event(event)
        _write_event(collect["db_path"], event)
        _maybe_dump("context.emitted", event, digest, context_field)
    except Exception as exc:  # noqa: BLE001
        try:
            _warn(f"emitted receipt skipped ({type(exc).__name__})")
        except Exception:
            pass


def note_output_failed(stage: str, exc: BaseException) -> None:
    """序列化或输出确实报错时（design §3.3 步骤 5）：尽力记 output_failed。

    不重发 stdout、不吞原有输出异常语义（宿主侧仍按原样传播/记录）。
    """
    collect = _collect
    if collect is None:
        return
    try:
        if stage == "flush":
            diagnostic = "stdout_flush_failed"
        elif isinstance(exc, OSError):
            diagnostic = "stdout_write_failed"
        else:
            diagnostic = "serialization_failed"
        totals = dict(collect["totals"], stdoutUtf8Bytes=None)
        event = _build_event(collect, "context.output_failed", totals, None, diagnostic)
        _write_event(collect["db_path"], event)
        _maybe_dump("context.output_failed", event, None, None)
    except Exception as exc2:  # noqa: BLE001
        try:
            _warn(f"output_failed receipt skipped ({type(exc2).__name__})")
        except Exception:
            pass


# ---------------- 启用探测（import 时执行一次） ----------------


def _candidate_roots() -> list[str]:
    roots: list[str] = []
    try:
        cwd = os.getcwd()
        if cwd:
            roots.append(cwd)
    except Exception:
        pass
    try:
        # 本模块随 hook 位于 <repo>/.codex/hooks/ → 上三级即仓库根（静态布局）
        roots.append(str(Path(__file__).resolve().parents[2]))
    except Exception:
        pass
    return roots


def _probe_enabled() -> bool:
    # 快速短路：观测未启用时每个候选根一次 stat 即返回，零额外开销
    for root in _candidate_roots():
        try:
            if os.path.exists(os.path.join(root, ".trellis", ".panel", "runtime", "binding.json")):
                return True
        except Exception:
            continue
    return False


def _arm() -> bool:
    """启用采集包装。探测失败/入口缺失 → False（hook 输出完全不受影响）。"""
    try:
        if os.environ.get("TRELLIS_RECEIPTS") == "off":
            _arm_debug("disabled_by_env")
            return False
        if not _probe_enabled():
            _arm_debug("probe_disabled")
            return False
        hook_module = sys.modules.get("__main__")
        if hook_module is None or getattr(hook_module, "__file__", None) is None:
            _arm_debug("no_main_file")
            return False
        _install_wrappers(hook_module)
        _install_test_failure_injection()
        _arm_debug("armed")
        return True
    except Exception as e:
        _arm_debug(f"exception:{type(e).__name__}")
        return False


def _arm_debug(reason: str) -> None:
    """诊断专用（默认零输出）：TRELLIS_ARM_DEBUG=<绝对路径> 时追加一行原因。"""
    path = os.environ.get("TRELLIS_ARM_DEBUG")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{reason} cwd={os.getcwd()} main={getattr(sys.modules.get('__main__'), '__file__', None)}\\n")
    except Exception:
        pass


def _install_test_failure_injection() -> None:
    """测试钩子（默认关闭）：TRELLIS_OBS_TEST_FAIL=serialize 时让宿主侧
    json.dumps 抛错，验证序列化失败 → output_failed 路径；emitter 内部序列化
    使用模块加载时捕获的 _json_dumps 引用，不受注入影响。仅冒烟测试使用。
    """
    if os.environ.get("TRELLIS_OBS_TEST_FAIL") != "serialize":
        return

    def _boom(*_args, **_kwargs):
        raise RuntimeError("obs-test: injected serialization failure")

    json.dumps = _boom  # noqa: B010 — 有意的全局注入（测试开关）


try:
    _ARMED = _arm()
except Exception:
    _ARMED = False
