# Restricted desktop bootstrap

## Scope / trigger

Applies to the ordinary Electron main window, `renderer/src/main.tsx`, `daemon/BootstrapGate.tsx` and the guarded native bootstrap API. Native ownership/protection contracts are in [integration-daemon.md](../backend/integration-daemon.md). A separately authorized restricted fixture compiled/loaded the actual preload/renderer and verified error/retry/exit and before-ready attachment denial. It deliberately used a failing diagnostic preparation port; complete desktop/native/provider acceptance remains separate.

The later separately authorized real recovery confirmed actual bootstrap ready **and** the full original project DOM/snapshot/screenshot after native ownership migration. This validates that incident's real desktop availability; historical inspection/switch/reconcile UI branches still retain their explicit source/isolated-test limits, and it is not broad provider/active-work/performance acceptance.

## Signatures

`BootstrapApi` in `shared/bootstrap.ts` exposes revisioned `status`/`onChanged`, explicit `retry`, `exit`, `minimize`, `maximize`, renderer `rendered`/`paint` receipts and full-App `attached`/`detached` receipts. It never exposes generic RPC, arbitrary roots, credentials, tasks or writable runtime settings.

Native-stage historical-owner `E_VERSION` has a narrow recovery exception: `legacyInspect`, exact `{epoch,owner}` `legacyStop`, and read-only `legacyReconcile`. Inspection runs only after an explicit click. The switch action appears only for a current native-validated idle/legacy capture, disables repeated actions, and enters ordinary Retry only after confirmed stop. Unknown stop retains its original command ID and offers original-result reconciliation; it cannot be cleared by another inspection/repeated stop/new command. No stop occurs merely from rendering, ordinary retry or GUI exit.

`BootstrapGate` delays the lazy full App until main publishes `ready`. Document/capsule/quicktodo/daemon-quit modes retain their separate composition. Full-App subscription attachment is distinct from the earlier restricted renderer commit.

## Launch presentation and motion

`daemon/StartupSplash.tsx` renders `StartupSplash({ status, entrance? })` with the existing `my/BrandMark` and `resources/brand/mark.svg` as its only glyph source. `daemon/startup.css` owns presentation using canonical `my-tokens` roles; it does not import App/store, add a theme palette or load remote assets. Three fixed clipping windows assemble one 96px mark above the product name and an indeterminate activity shuttle.

The restricted `.my-startup-window` must also carry `.my-root` and `data-my-theme`; the shared mark's ink/mask rules, controls, focus and reduced-motion styles depend on that scope. During handoff, the startup and App roots remain siblings rather than nesting a second `.my-root` inside App.

- Normal connecting/preparing/ready-pending UI shows only the brand name as visible copy. The phase and optional UI-preference warning remain in a visually hidden live status; do not replace this with visible technical state explanations. Mark the visual region `aria-busy=true`, with the live status outside that busy region so announcements are not deferred. A real `ui.warning` additionally exposes an icon-only, default-closed corner disclosure (`查看外观设置提示`) with the exact warning on expansion; healthy startup has no such disclosure.
- A persistent startup overlay preserves the same shell/splash instance through connecting, preparing, native ready, lazy App resolution, Settings/project bootstrap and the actual initial page chunk. The indeterminate shuttle never implies measured completion or a percentage.
- Native ready mounts the lazy App underneath the opaque cover immediately. Do not reveal the App merely because its outer import resolved: Settings/project/focus bootstrap and the actual visible route primary content must commit first. Then retire only the overlay with the canonical 200ms linear opacity transition. The App itself remains fully opaque and untransformed; do not restore the previous half-opacity/vertical whole-page entry. No minimum splash duration or timeout grants readiness, and visual handoff never delays `rendered`, paint or App attachment receipts.
- Animate only transform/opacity. Under reduced motion the mark/name are complete with no travel. The global `my-components.css` reduced-motion rule also truncates the optional opacity treatment; preserve that user preference rather than overriding it with `!important` motion.
- Startup uses its own restricted title bar with existing drag/no-drag semantics and named minimize/maximize/exit buttons. Ordinary desktop and auxiliary window composition are unchanged.
- Recovery uses a compact heading, a short human instruction and the applicable real actions. Raw error messages, stage/code/outcome, original migration/release/stop IDs and inspected owner facts belong to closed diagnostic disclosures. Lazy import rejection remains caught above App, including non-Error/falsy thrown values. An unavailable bridge or explicit failure phase must not show an endless activity animation.
- Legacy inspect/stop/reconcile remain explicit user actions. Compacting their presentation must retain pending/unknown latches, exact identities, inspection prerequisite, disabled repeat/ordinary retry and read-only original-result reconciliation.

This presentation amendment was exercised in an isolated browser fixture importing the actual component: both themes at 1440/768/390, phase continuity and stale revision, reduced motion, pending lazy readiness, immediate workspace mount, error retry, missing bridge, legacy unknown/reconcile and rejected lazy chunk. The fixture has no native authority/profile/provider connection; this is visual/renderer evidence, not native lifecycle acceptance.

### Actual page readiness and continuous handoff

`daemon/StartupContext.tsx` owns renderer-only `StartupPresentation { initialTheme, register, changed }`, `StartupContentRegion({ identity, active?, children })` and `StartupContentCommit({ active? })`. These receipts never grant native authority or replace `BootstrapApi.attached`.

- Register visible regions outside their Suspense boundaries so a pending primary branch remains an explicit uncommitted region. Put commit markers inside actual primary content, never its loading fallback. Region identity follows the real page/root/retained ACP owner/task surface; inactive retained sources do not hold or claim visible readiness. Distinct marker tokens prevent one cleanup from revoking another current marker in the same region.
- The normal page, active ACP source, and visible task preview/expanded task each participate as appropriate. Preserve retained reader instances and existing interaction scope; readiness registration must not remount the source. Terminal page/global ErrorBoundary fallback supplies a commit marker so recovery cannot remain covered indefinitely.
- `MainApp` does not expose Onboarding before `useApp.bootstrapped`. A completed legitimate no-project state commits Onboarding. App uses the presentation theme until Settings is authoritative, avoiding a default-theme flash during async bootstrap. Async bootstrap rejection is caught and rethrown on render into the restricted outer recovery boundary, including falsy rejection values.
- All active regions must have current primary commits, followed by two cancelable frames. Marker cleanup, Suspense hiding, route replacement or Gate cleanup revokes pending frame work. Until the initial reveal has fully completed, a newly pending active region also revokes an in-flight fade: immediately restore opaque cover with no reverse transition, invalidate that attempt and wait for new primary receipts. Once fully revealed, ordinary navigation does not resurrect startup. During the handoff the App host is inert/aria-hidden; remove those after the cover retires without moving focus. Bounded visual cleanup is pinned to the current reveal attempt and rechecks its receipts; stale transition events do not finish another reveal. This cleanup is not a readiness source. Reduced motion skips the fade.
- Keep the original outer App failure independently of App eligibility and of later window-operation failures. If Exit reports failed/unknown GUI cleanup after an App failure, restricted reload/exit controls and both original and cleanup diagnostics must remain visible. Never exclude both recovery surfaces because a sticky App error made App ineligible.

The initial handoff bug was reproduced using the actual App/MyApp: Settings/project delays exposed temporary Onboarding; delayed `YourWorkPage.tsx` then exposed the page fallback. The fixed isolated fixture deliberately held those same three stages in both themes, without a `theme` URL parameter: the same splash stayed opaque until real home content, then frame samples showed a linear cover fade with App opacity 1/transform none and stable theme. Actual no-project, Settings rejection/restricted recovery and reduced-motion cases were also exercised. An additional StrictMode case replaced the route during the fade while the real WorkItemsPage request stayed intercepted: cover returned opaque/inert until the new page committed; a failed Exit after bootstrap rejection retained both diagnostic causes and actions. The earlier immediately-ready Workspace stub alone was insufficient to validate this contract. This evidence is frontend-only, not a native or packaged startup performance claim.

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
