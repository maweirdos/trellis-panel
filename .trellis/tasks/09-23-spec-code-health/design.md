> Clean-room implementation: informed by SpexCode's public feature descriptions only; no SpexCode code or prose is reused.
> Reference: https://github.com/shuxueshuxue/Spexcode and https://spexcode.net/sync/

# Technical Design: Spec / Code Health

## Change boundary

Current spec files are browsable/editable and backlink counts exist, but a spec cannot claim the code it governs and no Git-derived staleness signal exists. Add optional file-level `code` metadata, a separate asynchronous health reader, and a small control surface in the existing Spec page.

Do not alter the project snapshot scan, database, agent workflow, channel runtime, git hooks, or CI. No automatic spec generation or behavior judgement.

## Data contract

Markdown files under `.trellis/spec/` may contain YAML front matter:

```yaml
---
code:
  - src/main/services/scan.ts
---
```

`code` accepts a string or string array for forward compatibility with hand-written files; writes canonicalize to a unique array using `/` separators. Paths are relative to the opened Trellis project root. Reject absolute paths, empty segments that escape the root, NULs, and any resolved path outside the project root. Preserve unrelated front matter keys when changing `code`.

The health response contains the current HEAD short/full SHA, a Git availability state, per-spec relative path, parse error if any, and per-code-path status plus up to three recent commit summaries. Statuses are `current`, `drift`, `working-tree`, `untracked`, `missing`, or `unknown`. A malformed/untracked spec cannot establish a committed baseline and is `unknown` with a reason.

Manual verification history lives separately from spec intent in `.trellis/spec-evals/<spec-relative-path>.jsonl`. Each append-only record has a generated `id`, human-written `scenario`, `expected`, `outcome: pass|fail`, optional `actual` and project-relative `evidence`, the current `head` SHA when available, and a Unix-millisecond `recordedAt`. This is a human evidence log, not an executable test definition. Code links stay in spec front matter; adding an evaluation does not change the spec's Git baseline.

## Git derivation

Run Git with `spawn` argument arrays and a bounded timeout from the project directory. Detect repositories through `git rev-parse --show-toplevel` rather than `.git` directory existence (linked worktrees use a `.git` file).

For each committed spec path, get its latest commit. Then query commits in `<specCommit>..HEAD` touching each declared code path. Any result is a drift signal, never a semantic failure. Query `git status --porcelain -- <path>` separately; local changes override the display status to `working-tree` while retaining committed history details. Files absent from disk are `missing`; files present but not tracked are `untracked`. No valid HEAD/history yields `unknown`.

Cache per canonical project root, keyed by HEAD and the current status output. Recompute on demand and provide an explicit refresh action. Never run this work as part of synchronous `scanProject()`.

## Main / renderer flow

`src/shared/spec-frontmatter.ts` owns parsing and serialization for both processes. Main process service `src/main/services/spec-health.ts` walks spec Markdown, resolves Git state, and implements bounded file picking. Register `spec:health` and `spec:pickCodeFiles` in the channel registry; handlers stay in `src/main/ipc/files.ts`, with errors returned through `ipcFail`.

Expose both operations through preload and `TrellisApi`. The renderer loads health on page open/root change and on manual refresh. Per spec, show linked paths and statuses in the document header/body, add files using Electron's native multi-select dialog rooted at the project, and remove paths with an optimistic spec write. Picker results are converted back to project-relative paths and revalidated in the main process.

The raw editor retains front matter. Rendered spec content strips only a valid leading front matter block. Existing docs without it render byte-for-byte as before. A validation card loads saved records newest-first and provides a compact form to append one to the sidecar; selected evidence files use a safe project-rooted picker and open through the existing validated reveal boundary.

## Performance and safety

- The renderer never accesses Node/Electron APIs directly.
- The service uses an async IPC request, a short timeout per Git operation, and a small cache; app startup and file watcher snapshot latency stay unchanged.
- Cap history summaries at three commits per linked file; no full project-wide source coverage crawl in this increment.
- File picker and metadata writes are limited to `.trellis/spec` and the opened project root.
- Evaluation evidence is stored as a relative path only; the picker rejects files outside the project and reveal revalidates containment. Sidecar paths are derived from validated spec paths, never accepted directly from the renderer.
- Git errors are represented as `unknown` with concise user-facing explanation; they do not throw through project scanning.

## Rollout / rollback

No migration is needed. Existing specs remain unchanged until a user adds `code` metadata. If the feature is removed, delete optional front matter manually or retain it as harmless Markdown metadata; there is no persisted app state to migrate.
