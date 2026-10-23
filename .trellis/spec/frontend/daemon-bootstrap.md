# Restricted desktop bootstrap

## Scope / trigger

Applies to the ordinary Electron main window, `renderer/src/main.tsx`, `daemon/BootstrapGate.tsx` and the guarded native bootstrap API. Native ownership/protection contracts are in [integration-daemon.md](../backend/integration-daemon.md). A separately authorized restricted fixture compiled/loaded the actual preload/renderer and verified error/retry/exit and before-ready attachment denial. It deliberately used a failing diagnostic preparation port; complete desktop/native/provider acceptance remains separate.

The later separately authorized real recovery confirmed actual bootstrap ready **and** the full original project DOM/snapshot/screenshot after native ownership migration. This validates that incident's real desktop availability; historical inspection/switch/reconcile UI branches still retain their explicit source/isolated-test limits, and it is not broad provider/active-work/performance acceptance.

## Signatures

`BootstrapApi` in `shared/bootstrap.ts` exposes revisioned `status`/`onChanged`, explicit `retry`, `exit`, `minimize`, `maximize`, renderer `rendered`/`paint` receipts and full-App `attached`/`detached` receipts. It never exposes generic RPC, arbitrary roots, credentials, tasks or writable runtime settings.

Native-stage historical-owner `E_VERSION` has a narrow recovery exception: `legacyInspect`, exact `{epoch,owner}` `legacyStop`, and read-only `legacyReconcile`. Inspection runs only after an explicit click. The switch action appears only for a current native-validated idle/legacy capture, disables repeated actions, and enters ordinary Retry only after confirmed stop. Unknown stop retains its original command ID and offers original-result reconciliation; it cannot be cleared by another inspection/repeated stop/new command. No stop occurs merely from rendering, ordinary retry or GUI exit.

`BootstrapGate` delays the lazy full App until main publishes `ready`. Document/capsule/quicktodo/daemon-quit modes retain their separate composition. Full-App subscription attachment is distinct from the earlier restricted renderer commit.

## Request / response / readiness contracts

- Phases: `window-ready -> connecting -> preparing -> ready`, with explicit `error|incompatible`. Apply the highest received revision; subscribe before fetching the current snapshot.
- First-window appearance reads only bounded non-secret desktop preferences/defaults. Do not mount the full store/settings graph merely to obtain a theme.
- Native preparation starts only after the restricted renderer commit and the first window show. The commit handshake permits work; buffered browser `first-paint` is the actual paint measurement.
- Online readiness requires authenticated native capability, actual `native.ready` and prepared read-only Settings credentials. A settings migration checkpoint is not full readiness. Manual/absent mode retains offline semantics.
- Native-stage retry reuses the original migration command/release identities. Partial full desktop installation is not re-registered in-process.
- Every bootstrap route checks the actual main window's WebContents and main frame; an auxiliary/subframe renderer cannot reuse it.
- Keep a recovery boundary above the lazy App so chunk evaluation failure still offers desktop recovery/exit. Suspense alone handles pending imports, not rejected imports.
- Delay cold/queued/inbox task-focus dispatch until full App subscriptions and initial project bootstrap attach. A visible bootstrap document is not a full-renderer-ready signal. Root/generation validation remains mandatory.
- An untouched shell can exit its GUI directly. Once desktop services start, failure/exit closes GUI admission and waits for GUI-owned cleanup; it must not stop the retained daemon or change its retention preference as an error-recovery side effect.

## Validation / error matrix

| Condition | Required behavior |
| --- | --- |
| Stale status response after newer event | Ignore older revision |
| Native unavailable or incompatible | Keep actionable shell; show sanitized stage/code and known original migration IDs |
| Partial full desktop registration failed | No automatic duplicate registration; retain exit/reload recovery |
| App chunk rejected | Outer recovery surface remains mounted |
| Full App not subscribed yet | Retain authenticated focus target; do not drop it into an unobserved event |
| Before-ready exit | Preserve daemon/owner; clean only GUI work that actually started |
| Renderer paint unsupported/missing | Leave measurement absent; do not invent a zero/fallback paint |

## Good / base / bad cases

Good: the shell paints while native preparation continues; a locked key produces a recoverable native-stage error with the original migration identity.

Base: an already-running compatible daemon is attached through the pooled transport, then the full App mounts after native readiness.

Bad: removing the preparation await while leaving full feature IPC/store active, treating settings phase as runtime readiness, or losing a deep-link target before lazy App subscription.

## Required acceptance

When separately authorized: compile main/preload/lazy renderer boundaries; observe cold/warm first show, paint, auth and full-ready separately; exercise failed/lost migration replies, incompatible owner, manual absence, partial desktop cleanup, rejected App chunk, deep links across project bootstrap, main/subframe/auxiliary IPC and normal quit behavior. Current no-build/test restrictions are not a pass for these cases.

Main monotonic markers and renderer-navigation paint use different clock origins. Record paint receipt separately; never subtract raw renderer paint from a main marker or call an earlier shell a measured full-ready speedup.

## Wrong vs correct

Wrong: `Suspense` is the only boundary around the lazy App and task-focus messages are emitted as soon as the bootstrap document stops loading.

Correct: keep bootstrap recovery outside the lazy import and require full-App subscription attachment before releasing authenticated focus work.
