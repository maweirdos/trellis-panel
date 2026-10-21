# Manual Git Workspace

## 1. Scope / Trigger

Read this when changing manual Git writes, their IPC/preload bridge or branch UI.
`services/git-workspace/` is separate from the bounded read-only Git viewer.
It is not an external Agent/TPAP capability and must never write the current
development repository as part of a smoke test.

## 2. Signatures

`src/shared/git-workspace.ts` owns strict Zod requests and `GitWorkspaceApi`:

```typescript
status({ expectedRoot }): Promise<GitWorkspaceStatusResult>
diff({ expectedRoot, path, staged }): Promise<GitWorkspaceDiffResult>
stage({ expectedRoot, revision, confirm: true, paths }): Promise<GitWorkspaceMutationResult>
unstage({ expectedRoot, revision, confirm: true, paths }): Promise<GitWorkspaceMutationResult>
commit({ expectedRoot, revision, confirm: true, message }): Promise<GitWorkspaceMutationResult>
createBranch({ expectedRoot, revision, confirm: true, name, switchAfter? }): Promise<GitWorkspaceMutationResult>
switchBranch({ expectedRoot, revision, confirm: true, name }): Promise<GitWorkspaceMutationResult>
push({ expectedRoot, revision, confirm: true, remote, branch, remoteBranch, setUpstream? }): Promise<GitWorkspaceMutationResult>
```

The facade takes canonical root, validated input and optional main-owned
`GitWorkspaceOperationOptions` (`guard`, `review`, `stillCurrent`). Register only
under `ipcInvoke.gitWorkspace`. Root-scoped diff delegates to the existing reader.

## 3. Contracts

- Main captures active root and project generation, compares `expectedRoot`,
  checks the ordinary main-window sender for writes and rechecks inside the
  repository queue and after native review. A -> B -> A is still stale.
- A snapshot includes actual branch/HEAD, unborn/detached state, staged/unstaged
  paths (including rename origin), untracked paths, branches, sanitized remotes,
  operation/conflict state and a 64-hex revision. The revision fences relevant
  HEAD, index, dirty content and configuration, not just the current branch name.
- Selected stage/unstage uses literal argv pathspecs and a private index under
  an exclusively held live `index.lock`; publication is verified. Unstage never
  rewrites working files. No wildcard, traversal or foreign-root requests.
- Commit review is native and main-owned. Snapshot/message are rechecked before
  using a private copy of the reviewed index; native pre-commit,
  prepare-commit-msg and commit-msg hooks run there. A changed tree or message
  fails closed. Commit publication uses old-HEAD compare-and-swap; signing follows
  `commit.gpgsign`. Post-commit failure reports an already-created commit honestly.
- Push reviews one configured remote URL and an explicit current HEAD object to
  destination-branch refspec. No implicit tags/mirror/submodule/force push. No
  background fetch/pull. Credentials are not displayed. Authentication helpers
  remain Git-owned; terminal prompting is disabled and execution is bounded.
  Redact URL userinfo for all URI transports, not only HTTP(S), before projecting
  configured remotes or native review text.
- Repositories with active external clean/process filters (including LFS) are
  rejected before state reads can execute those filters. Gitlink staging and
  branch switching with submodules are explicitly unsupported, not auto-managed.
- Commands use `spawn` argv (no shell), strip inherited Git root/index/config
  redirections, disable optional read-side effects and lazy fetch, bound stdout
  (4 MiB), stderr (32 KiB) and time (30s local, 60s push). Limits also bound dirty
  content/index reads; over-limit state fails instead of being called clean.
- Timeout/overflow stops only the invocation-owned tree within a bounded cleanup
  budget. Unverified cleanup retains transaction files/index lock and reports
  `uncertain`; never delete a foreign/stale lock or claim remote rollback.
- Failures may include `mutationCompleted`, `committed` and `uncertain`. UI must
  show those outcomes and refresh deliberately rather than blindly repeat writes.
  Access logs contain summaries, not commit messages, credentials or raw output.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| No project / foreign root / wrong sender | No write; structured unavailable/denied error |
| Strict DTO, empty path/message, invalid branch/remote | `E_INVALID_ARG` before mutation |
| Stale revision, concurrent index/HEAD change, conflict/operation | `E_CONFLICT`; refresh and review again |
| Dirty or occupied branch switch | Explicit rejection; no stash, force or discard |
| Existing index lock | Fail without removing or replacing its owner |
| Missing Git / non-repository | Honest unavailable/not-found state |
| Cancelled native commit/push | `E_DENIED`; zero commit/push |
| Hook changes private tree/message | Conflict; no reviewed commit publication |
| Post-commit hook / post-push upstream failure | Failure with `mutationCompleted`; do not duplicate work |
| Post-checkout hook fails after HEAD changed | Observe actual branch and report `mutationCompleted`; never imply rollback |
| Push rejection / auth / timeout | Actionable failure, never retry as force; timeout is uncertain |

## 5. Good / Base / Bad Cases

Good: stage one Unicode path, review exactly its staged tree, commit while other
working files remain untouched, then push explicitly to a local fixture remote.
Base: an unborn repository stages and unstages a file without changing its bytes.
Bad: reuse a stale branch label as authority, run `git add .` for a selection,
include concurrently staged content or automatically remove an index lock.

## 6. Tests Required

- `git-workspace.mjs`, `git-workspace-safety.mjs` and
  `git-workspace-boundaries.mjs`: disposable normal/unborn/
  linked worktree repos, rename/delete/space/Unicode, exact selected paths,
  stale content/index/HEAD, hook races, queue guards, bounds/cleanup and ordinary
  push/rejection to a local bare remote. Assert actual bytes, refs and index.
- `git-workspace-ipc.mjs`: actual eight handlers, strict requests, current sender,
  root A -> B -> A, queued guards, native cancellation and scoped/stale diff.
- `git-workspace-ui.mjs`: typed mounted UI, failures/cancellation, stale replies,
  both themes/fonts, short viewport and maximum dock geometry.
- `developer-tools-e2e.mjs`: built UI/preload/actual IPC, selected stage/commit,
  create/switch branch and local bare push while a real service stays alive.
  Native human choices are simulated and must be labelled as such.
- Preserve `git-readonly.mjs`, `git-algorithms.mjs`, IPC registry, typecheck/build.

## 7. Wrong vs Correct

Wrong: renderer calls an arbitrary shell command/root with `confirm: true` and
immediately shows success; `git commit -a` includes unreviewed work.

Correct: strict stored domain requests, captured main root/generation and native
review, verified private index plus CAS, then actual result/error projection.
