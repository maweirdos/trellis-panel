# Auxiliary read-only Git viewer

## Scope and ownership

The existing developer-tools Git entry provides Workspace and History views. It is an auxiliary inspector, not a Git client. Keep the Electron host and React 18. Do not add Git writes, background polling, a separate desktop runtime, new dependencies or a general provider framework for this view.

Main owns repository access. Renderer components under `my/git/` own only presentation and request generations. The parent page keys the viewer by project. New channels belong to `ipcInvoke.devtools` and use the existing main registry/preload boundary.

## Signatures and data contracts

`src/shared/git-readonly.ts` defines the shared DTOs and limits:

```ts
devtoolsGitHistory(request: GitHistoryRequest): Promise<GitHistoryResult>
devtoolsGitCommit(request: GitCommitRequest): Promise<GitCommitResult>
devtoolsGitCommitDiff(request: GitCommitDiffRequest): Promise<GitCommitDiffResult>
```

- All requests carry `expectedRoot`; main captures its own active root and rejects mismatch. Renderer must not choose the executable directory.
- History takes an optional offset and expected `revision`. A page contains full commit IDs, parent IDs, author, Unix-millisecond timestamp, subject, HEAD and local branch/remote/tag refs. Page size is 100; the accumulated viewer is limited to 1,000 commits. This is a bounded offset-pagination exception, not a scalable cursor guarantee.
- A revision binds pages to the same HEAD/refs snapshot. A changed snapshot produces a conflict rather than mixing histories. Refresh restarts from page zero; a stale load-more must not preserve an apparently complete mixed list.
- Commit/detail calls take a full validated object ID. Commit-file diff also takes a relative path validated against that commit's changed files. Do not accept arbitrary revision expressions, raw commands or shell text.
- A merge is compared with its first parent; a root commit is compared with an empty tree. Show that comparison explicitly. Parse paths with NUL delimiters and preserve rename, spaces and non-ASCII names.
- Numstat rename records contain an empty path field followed by two raw NUL-delimited paths; consume both paths as data even when they resemble numeric stats. A selected file diff must exclude sibling/descendant changes when a filename becomes a directory (or vice versa). Follow a rename from its new path and filter by the validated changed-file status.
- Success results carry the captured root. Failure results use `IpcFail` with a registered `code`. Existing Workspace status/file-diff methods retain their compatible shapes.

## Reading and resource bounds

The viewer uses bounded process output and a timeout. Count bytes while reading stdout/stderr; do not collect unlimited output and call string `slice` afterwards. Text diff keeps the 128 KiB budget with an explicit `truncated` flag. Metadata overflow is a readable failure.

Use fixed Git subcommand builders, argument arrays and `windowsHide`. Disable optional index writes and external diff/textconv execution. Do not run active repository content filters to produce a workspace diff; report an unsupported read when needed. LFS/filter emulation is outside this viewer. These read-only rules do not change the separate task branch-creation service.

Force `diff.suppressBlankEmpty=false` so blank context rows retain their space marker and the hunk parser keeps subsequent line numbers correct regardless of local Git configuration. Smoke cleanup validates the exact absolute fixture directory, its temporary parent and its own prefix before recursive removal.

No implicit fetch occurs. A local remote ref is a locally recorded value. Missing Git, no repository and an unborn/detached HEAD are distinct states. A .git file at a linked-worktree root is valid.

## Validation and error matrix

| Condition | Required behavior |
| --- | --- |
| No active project / expectedRoot mismatch | Reject through the existing IPC error envelope; never silently read another project |
| Invalid object ID or changed-file path | Invalid-argument failure before the unsafe query |
| History revision changes between pages | Conflict and restartable history state |
| Missing Git, timeout or metadata cap | Readable failure; no fake empty history |
| Empty repository | Real empty state, no assumed main branch |
| Binary or oversized text diff | Binary/truncation explanation, no invented complete text |
| Old request resolves after project/selection changes | Ignore it; do not replace current files or diff |

## Presentation and provenance

Use the existing centered developer-tools layout and semantic theme tokens. History renders only the needed graph region; unified diff uses real hunk line numbers and add/remove styling. No donor CSS resets, private palette, full App component, split diff or syntax engine.

The graph layout/visible-edge and patch-row algorithms are adapted from oil-git commit `9e6abfabe63503b5122b1762a8902ecefe9473fc`. Keep copyright, source revision and the packaged `resources/licenses/oil-git.txt`. Porting frontend algorithms does not inherit the donor Rust backend's behavior or performance guarantees.

## Cases and verification

- Good: page two of an unchanged graph preserves previously loaded commits and cross-page parent edges; a selected commit shows its actual changed files.
- Base: an empty repository shows an empty history while the Workspace entry remains usable.
- Bad: appending a new revision to an old page, comparing a merge without explaining its parent, or displaying a previous project's delayed diff.

Required focused checks cover merge/cross-viewport/page-boundary graph edges and hunk/no-newline line numbers, plus temporary real Git repositories for root/merge commits, renames, dirty index/worktree, stale refs/root and unchanged observed repository data. Run the available type/UI/build scripts and report native UI verification separately from no-IPC preview.

Wrong: `spawn('git ' + rendererInput)` or unbounded output followed by string truncation. Correct: a fixed read operation, validated project/object/path, byte cap, typed failure and a renderer generation check.
