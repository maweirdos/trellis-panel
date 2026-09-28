# Implementation Plan

## 1. Shared metadata contract

- Add a small shared helper to split, parse, and serialize leading YAML front matter while preserving unknown keys.
- Canonicalize `code` to unique `/`-separated project-relative paths; implement path containment validation in the main process.
- Expose compact shared health types for IPC.

## 2. Git health service

- Add an asynchronous service that reads tracked spec/code history, working-tree state, and recent commit summaries.
- Detect a Git checkout through `git rev-parse`; support linked worktrees and non-Git projects.
- Apply a process timeout, bounded output, per-project cache, and explicit refresh.
- Keep Git analysis out of `scanProject()`.

## 3. IPC and safe file picking

- Register `spec:health` and `spec:pickCodeFiles`.
- Keep handlers thin in `src/main/ipc/files.ts`, use `ipcFail` on failures, and expose typed methods through preload.
- Use a native multi-file picker rooted at the open project. Return only validated relative paths.

## 4. Spec page

- Fetch and refresh health data without blocking existing document rendering.
- Show code links, commit summaries, and separate status labels on a selected spec.
- Add/remove paths through the existing optimistic `writeSpecFile` path and preserve unrelated front matter.
- Strip front matter from rendered spec Markdown only; retain it in raw editing.

## 5. Manual evaluation evidence

- Add an append-only JSONL sidecar service under `.trellis/spec-evals/`, keyed from a validated spec-relative path; keep it outside the spec document so evaluations do not move the code/spec drift baseline.
- Add a compact Spec-page form for scenario, expected/actual result, pass/fail, and optional evidence file.
- Capture current HEAD and Unix-millisecond recorded time; show prior records newest-first and reveal evidence only through the validated project-relative API.
- Do not execute scenarios or introduce an eval DSL/test runner.

## 6. Focused verification

- Run `npm run typecheck` and `npm run build`.
- Exercise a minimal temporary Git fixture for same-commit baseline, later code commit, and dirty code status; exercise a linked worktree / no-Git path if practical.
- Manually inspect the Spec page for a document with and without front matter, add/remove one association, and check that non-Git errors remain contained.
- Append two evaluation records and confirm both remain in the spec; verify an evidence file outside the project cannot be selected or revealed.
- Do not add a broad test framework or run unrelated tests.

## Rollback points

- If Git history scanning affects responsiveness, disable health autoload and keep explicit refresh while retaining the metadata parser and UI.
- If file picker security validation fails, remove picker writes and leave the existing Markdown editor as the metadata authoring path.
- No database migration or irreversible data operation is planned.
