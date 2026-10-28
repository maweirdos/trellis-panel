"""Explicit team authority guards; legacy local/HiFox tasks stay local."""

from __future__ import annotations

import sys

TEAM_ADAPTER_VERSION = 1


def is_team_managed(data: dict) -> bool:
    meta = data.get("meta")
    return isinstance(meta, dict) and meta.get("panel_task_authority") == "team"


def is_reserved_task_meta(key: str) -> bool:
    return (
        key in ("panel_task_authority", "panel_operation_id")
        or key.startswith("panel_hifox_")
        or key.startswith("panel_team_")
    )


def preserves_team_authority(previous: dict, proposed: dict) -> bool:
    """Reject stale local rewrites of centrally owned state and provenance."""
    if not is_team_managed(previous):
        return True
    old_meta = previous["meta"]
    new_meta = proposed.get("meta")
    if not isinstance(new_meta, dict):
        return False
    reserved = {key for key in old_meta.keys() | new_meta.keys() if is_reserved_task_meta(key)}
    return (
        proposed.get("status") == previous.get("status")
        and proposed.get("completedAt") == previous.get("completedAt")
        and all(key in old_meta and key in new_meta and new_meta[key] == old_meta[key] for key in reserved)
    )


def refuse_team_archive(data: dict) -> bool:
    if not is_team_managed(data):
        return False
    print(
        "Error: 在团队任务页完成验收或取消；团队任务不支持本地 archive。 "
        "Open Team > Tasks to accept or cancel the original task. "
        "Local status or cached completion is not "
        "online service confirmation; no task state or directory was changed.",
        file=sys.stderr,
    )
    return True
