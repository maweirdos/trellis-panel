# Implementation entry boundary

Date: 2026-10-16. Final validated plan approved by the user's “那现在开始任务吧”; task.py start recorded in_progress on branch codex/trellis-team-refactor.

## Smallest behavior gap and ownership

The existing handwritten ACP client cannot reliably perform real vendor conversations because remote identity, protocol/event/permission handling and lifecycle behavior are incomplete. Replace that mechanism with the public acpx runtime; the approved compatibility patch closes only handshake/readiness, raw inbound ownership and exact permission choice. Do not introduce another generic supervisor.

The patch implementer owns exact dependency/lockfile, versioned compatibility patch, preparation checks and strict regression fixtures. The backend implementer owns ACP types/channels/preload, the main facade/helpers/IPC and a scoped awaitable before-quit guard in main/index.ts; the existing acp-project-scope smoke is also its single-writer responsibility. The frontend implementer owns the Agent/conversation page/components, ACP Settings section and separate UI tests. Shared public contracts are published by the backend before UI wiring. All are Trellis implement agents instructed not to spawn nested implement/check agents.

Every new file must serve the task acceptance criteria. The shell, ordinary Chat, unrelated task metadata, credentials, provider/model choices and unrelated dirty code are not rewritten. Runtime code remains an installed pinned dependency plus an explicitly maintained patch, not copied into the application's source tree. The app adapter boundary permits future source-vendoring without scattering imports through business/UI code.

## Entry baseline

Full pre-existing status and binary diff are saved outside Git under the current chat visualization directory's acp-implementation-baseline. Earlier ACP-only baseline and unpatched research package/evidence remain unchanged. Existing service/IPC/renderer edits and independent UI work are preserved, not reset.

The project has an existing electron-vite5 peer range conflict with Vite8. Dependency installation uses the existing-version-preserving legacy-peer-deps path; this task does not upgrade/downgrade the build stack. The tested ACP protocol SDK transitive is pinned to 1.8.0 under acpx to prevent an unreviewed later resolution.

## Verification ownership

Implementers run scoped regression/type/build checks, accounting for dependency/contract handoffs before reporting final failures. The coordinator handles integration, actual renderer/native/vendor/package walkthrough, spec updates and final review. A dedicated Trellis check agent follows implementation. Existing failed stock experiments stay failed baselines; only patched/product-created evidence can close the corresponding implementation criteria.

Claude conversation succeeds with explicit user-settings inheritance; the sample-file criterion is still open. Root investigates it in isolated research scripts without changing credentials or provider/model settings. No mock/build/greeting result substitutes for that acceptance.
