# 上游 PR 草稿（本地备稿，未推送）

> 状态：**LOCAL DRAFT — NOT SUBMITTED**。按 ac-matrix 用户动作第 5 条，用户选"发"后先过目本稿再定；选"不发"则本稿作废，缺口走本地维护（known-issues 已登记）。
> 目标仓库：`github.com/mindfold-ai/trellis`（模板源 `packages/cli/src/templates/`，npm `@mindfoldhq/trellis`，本地 0.6.17 = dist-tags.latest，见 host-distribution.md §1）。
> 建议拆两个 PR（互不依赖，可分别审）；草稿正文如下。

---

## PR 1 — feat(codex-hooks): optional observability receipts for subagent context injection

**Title**: `feat(codex): optional assembled/emitted receipts for SubagentStart context injection`

### Body

```markdown
## What

Adds an optional, fully-bypassable observability module to the Codex
`SubagentStart` context-injection hook template, so tooling can verify what
context a sub-agent actually received (and whether the hook output actually
reached stdout), without changing hook behavior in any way.

## Why

Today the injected context is a black box: when a sub-agent starts with no
task context, there is no on-disk evidence of whether the hook ran, matched,
assembled context, or successfully wrote to stdout. Post-hoc inspection of
the conversation cannot distinguish "hook injected context the model then
ignored" from "hook silently skipped injection" — these are very different
failure modes during rollout.

## Design (anti-falsification rules)

- The hook's stdout stays **byte-identical** when observability is on or off
  (verified with sha256 against git HEAD across 14 fixture payloads).
- Receipts are written to a local SQLite store only after a three-way
  identity check (installation ↔ repo binding ↔ canonical root); any
  mismatch means "skip silently", never "block the hook".
- Two events per injection, paired by `injectionId`:
  `context.assembled` (context built, before stdout write) and
  `context.emitted` (after stdout write+flush). Write/flush failures emit
  `context.output_failed` instead of `emitted` — an emitted receipt can
  never exist without a successful stdout write.
- Every failure path of the emitter is swallowed; the emitter can never
  change the hook's exit code or stdout.

## Evidence (from a downstream production fork)

- 117-assertion smoke matrix covering: byte-identical stdout, identity
  mismatch, store failure, output failure, duplicate suppression.
- Cross-language payload digest parity (TS reader ↔ Python producer) proven
  with golden fixtures.
- End-to-end in a real interactive Codex TUI session (0.159.2): native
  `spawn_agent` dispatch → SubagentStart fired → context injected →
  assembled/emitted pair persisted with `producer.host=codex` and the real
  parent session id.

## Compatibility

- Zero new runtime dependencies (stdlib `sqlite3`, `json`, `hashlib`).
- Off by default until the panel-side binding file exists
  (`.trellis/.panel/runtime/binding.json`); absent file = zero behavior
  change for every existing user.
```

---

## PR 2 — fix(task-cli): persist the active-task pointer when Codex TUI exposes no session identity env

**Title**: `fix(cli): task.py start should not silently skip the session pointer inside Codex TUI`

### Body

```markdown
## What

Two small changes so `task.py start` keeps working when Codex's interactive
TUI spawns shells **without exporting any session identity environment
variable**:

1. `task.py start --context-key <key>`: explicit override that persists the
   active-task pointer under the given key (same code path as
   `TRELLIS_CONTEXT_ID`, just first-class).
2. A reconciliation step in the Codex `UserPromptSubmit` hook template:
   that hook *does* receive `session_id` in its stdin payload. On the first
   prompt of a session whose pointer file is missing but whose
   "pending start intent" file exists, bind the intent to this session key.

## Why (root-caused in the wild)

Inside the Codex TUI (0.159.x), hook stdin payloads carry `session_id`,
but tool/shell subprocesses get no identity env (`CODEX_THREAD_ID` etc.
are not exported). Therefore `task.py start` run from the agent's shell
resolves no context key and takes the degraded path: task.json status
flips, but **no session pointer is written**.

The `SubagentStart` hook then looks the pointer up by the parent session id
(key format `codex_<session-id>`, `allow_single_session_fallback=False` by
design — correct, it prevents borrowing another window's task), finds
nothing, and **silently skips context injection for every native sub-agent
dispatch**. No stderr, no injection, no error — the sub-agent just runs on
the dispatch prompt alone.

Verified end-to-end: once the pointer exists under the expected key, the
very same hook injects context and emits receipts normally (evidence in
the linked report).

## Workaround today (to document even if the fix diverges)

    TRELLIS_CONTEXT_ID=codex_<TUI session id> python .trellis/scripts/task.py start <task>

## Also worth noting (upstream-of-upstream)

`codex exec` does not fire `SubagentStart` at all (verified on 0.159.2 and
0.162.1). That part belongs to openai/codex, not this repo; happy to link
our repro notes if useful.
```

---

## 附：发 PR 前的本地检查单（选"发"后执行）

1. `git clone` 上游，定位 `packages/cli/src/templates/` 下 codex 平台 hook 模板与 task CLI 的确切路径（host-distribution.md §4 第 1 项待验证）。
2. 把本仓 `.codex/hooks/observability_emit.py` + `inject-subagent-context.py` 的三处时机点调用整理为模板补丁；PR 2 的 `--context-key` 对齐 task.py 实际参数风格。
3. 在干净临时仓库跑 `trellis update` 三态验证（未改/已改/新增文件）。
4. 英文正文以本稿为底，按上游 CONTRIBUTING 调整；提交前请用户过目最终 diff。
