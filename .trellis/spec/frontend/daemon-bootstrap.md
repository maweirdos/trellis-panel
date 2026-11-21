# Restricted desktop bootstrap

## Scope / trigger

Applies to the ordinary Electron main window, `renderer/src/main.tsx`, `daemon/BootstrapGate.tsx` and the guarded native bootstrap API. Native ownership/protection contracts are in [integration-daemon.md](../backend/integration-daemon.md). A separately authorized restricted fixture compiled/loaded the actual preload/renderer and verified error/retry/exit and before-ready attachment denial. It deliberately used a failing diagnostic preparation port; complete desktop/native/provider acceptance remains separate.

The later separately authorized real recovery confirmed actual bootstrap ready **and** the full original project DOM/snapshot/screenshot after native ownership migration. This validates that incident's real desktop availability; historical inspection/switch/reconcile UI branches still retain their explicit source/isolated-test limits, and it is not broad provider/active-work/performance acceptance.

## Signatures

`BootstrapApi` in `shared/bootstrap.ts` exposes revisioned `status`/`onChanged`, explicit `retry`, `exit`, `minimize`, `maximize`, renderer `rendered`/`paint` receipts and full-App `attached`/`detached` receipts. It never exposes generic RPC, arbitrary roots, credentials, tasks or writable runtime settings.

Native-stage historical-owner `E_VERSION` or `E_UNAVAILABLE` has a narrow recovery exception: `legacyInspect`, exact `{epoch,owner}` `legacyStop`, and read-only `legacyReconcile`. The startup page may perform one read-only inspection automatically for the initial failure, then leaves retry and exit under explicit user control. A missing historical owner is only a diagnostic result; it never authorizes an automatic retry or owner replacement. The switch action appears only for a current native-validated idle/legacy capture, disables repeated actions, and enters ordinary Retry only after confirmed stop. Unknown stop retains its original command ID and offers original-result reconciliation; it cannot be cleared by another inspection/repeated stop/new command. No stop occurs merely from rendering, ordinary retry or GUI exit.

`BootstrapGate` delays the lazy full App until main publishes `ready`. Document/capsule/quicktodo/daemon-quit modes retain their separate composition. Full-App subscription attachment is distinct from the earlier restricted renderer commit.

## Restart and upgrade confirmation

The separate `daemon-lifecycle` renderer mode works before full desktop readiness.
It exposes only `daemonLifecycleDialog.state` and `daemonLifecycleDialog.decide`
through its dedicated preload bridge; main validates the actual dialog window,
main frame and attempt ID. The lifecycle coordinator owns original-process
confirmation and revalidation; UI approval alone is never process authority.

Use `showDaemonLifecycleConfirmation({attemptId, reason, sessions, uncertain})`.
The reason selects restart or update wording. Display at most five bounded
session names and disclose any additional count. Unknown state warns that the
current response may be interrupted; only already-saved history is promised.
Read appearance from the non-secret desktop preferences, not the full Settings
store. Reuse shared theme, density, Button and 10px geometry.

The ordinary main frame publishes only `{fontSize: 'small'|'standard'|'large'}`
through `bootstrap.appearance`. Main validates the strict payload and atomically
writes `daemon-v1/<mode>/desktop-appearance.json` with `version: 1`. The restricted
shell seeds this derived snapshot from an actually stored valid preference;
explicit density changes and cross-window storage changes refresh it. Auxiliary
windows and subframes cannot write it. Snapshot write failure does not change the
GUI preference or block startup.

`desktopUiPreferences()` reads that bounded non-secret snapshot and passes density
through the lifecycle preload arguments. Maintenance/control retain their separate
sessionData directories. The dedicated dialog uses a non-persistent
`crux-lifecycle-<attemptId>` partition, including before the old GUI exits; its
appearance comes exclusively from the native snapshot. Never share the GUI
session or inspect its LevelDB.
Older profiles without a snapshot use the maintenance renderer's Standard
fallback; absence is not evidence of the user's saved preference. Invalid snapshot
bytes remain intact, return an appearance warning and supply no captured density.
Verify propagation through separate actual GUI and maintenance processes, not
only by injecting `fontSize` into a rendering fixture.

The private `gui-launcher` role has no renderer. It creates the real GUI inside
its protected native Job before desktop composition. Launcher sessionData stays
separate from the persisted GUI session. Cancelling the pre-lock development
confirmation forwards focus to an existing instance and exits this new launch
before publishing any replacement GUI owner.

Default focus is Cancel. Escape, window close and load failure cancel before
execution. Repeated pending calls for the same attempt join the existing window;
an already-settled UI attempt cannot cache permission for another stop.
`runDaemonLifecycleWithDialog` keeps that same restricted window after approval,
projects the coordinator's stopping/terminating/verifying phases and closes only
after verified release. Automatic idle exits also have a progress window.
State-only polling restores the current phase after a renderer reload; it never
resubmits a decision. Execution has no Cancel action, and native close/Escape
cannot revoke an accepted stop.

Once cleanup has settled as failed, show a concise failure with explicit
`retry`/`close` actions and default-closed details containing the original command
and reason. Retry runs the coordinator against its retained attempt and approval,
not a fresh confirmation. Closing this failure is not successful exit or consent
to installer overwrite. During pre-lock development startup, closing the failure
exits that new controller before requesting the GUI single-instance lock or
creating a desktop bootstrap; it must not reopen the same failure. Development, build replacement, explicit desktop control
and interactive maintenance use this presenter before full App readiness; silent
maintenance retains its noninteractive result contract.
Before the first main BrowserWindow is successfully created, closing a transient
lifecycle progress window must not trigger bootstrap exit through
`window-all-closed`. Set `mainWindowCreated` only after the main constructor
succeeds; retain normal close/exit behavior once that window has existed. Verify
this with delayed GUI endpoint initialization and the full normal dev entry.
Confirmation invokes the dedicated lifecycle path, never generic retry or a
hidden force-stop behind ordinary GUI exit. See the
[native lifecycle contract](../backend/daemon-lifecycle.md) for admitted,
uncertain and timed-out operations.

Verify the actual component in both themes and all three densities, long names,
narrow width, keyboard focus/activation, reduced motion, unavailable bridge and
rejected decisions. Check native window/main-frame/attempt guards separately;
browser rendering does not prove process cleanup or installer handoff.
Also exercise delayed stop, visible progress continuity and failure/retry using
the same attempt identity; confirmation-only screenshots do not cover that flow.

## Launch presentation and motion

`daemon/StartupSplash.tsx` renders `StartupSplash({ status, entrance?, active? })` using shared `BrandMotion` and `BrandWordmark` backed by `resources/brand/`. `daemon/startup.css` owns presentation using canonical `my-tokens` roles; it does not import App/store, add a theme palette or load remote assets. The 96px mark remains in panoramic observation throughout startup. Do not switch it to the grouped loading state after a timer or add a second activity indicator.

The restricted `.my-startup-window` must also carry `.my-root` and `data-my-theme`; the shared mark's ink/mask rules, controls, focus and reduced-motion styles depend on that scope. During handoff, the startup and App roots remain siblings rather than nesting a second `.my-root` inside App.

- Normal connecting/preparing/ready-pending UI shows only the brand name as visible copy. The phase and optional UI-preference warning remain in a visually hidden live status; do not replace this with visible technical state explanations. Mark the visual region `aria-busy=true`, with the live status outside that busy region so announcements are not deferred. A real `ui.warning` additionally exposes an icon-only, default-closed corner disclosure (`查看外观设置提示`) with the exact warning on expansion; healthy startup has no such disclosure.
- A persistent startup overlay preserves the same shell/splash instance through connecting, preparing, native ready, lazy App resolution, Settings/project bootstrap and the actual initial page chunk. Observation expresses ongoing activity without a completion percentage.
- Native ready mounts the lazy App underneath the opaque cover immediately. Do not reveal the App merely because its outer import resolved: Settings/project/focus bootstrap and the actual visible route primary content must commit first. The observed mark then shrinks and travels from its measured central rectangle to the real title-bar mark, followed by restrained elastic docking. The background and wordmark fade independently so the traveling mark remains visible. The App itself remains fully opaque and untransformed. No minimum splash duration or timeout grants readiness, and visual handoff never delays `rendered`, paint or App attachment receipts.
- Animate only transform/opacity. Under reduced motion the mark/name are complete with no travel. The global `my-components.css` reduced-motion rule also truncates the optional opacity treatment; preserve that user preference rather than overriding it with `!important` motion.
- Startup uses its own restricted title bar with existing drag/no-drag semantics and named minimize/maximize/exit buttons. Ordinary desktop and auxiliary window composition are unchanged.
- `startStartupBrandHandoff(root, complete)` in `startup-brand-handoff.ts` measures `[data-startup-brand-source] .my-brand-motion` and `[data-startup-brand-target] .my-brand-mark`. The original source retains its 96px placeholder while its fixed-position artwork travels for 420ms with linear translation/scale. A 140ms docking segment limits directional overshoot to 1px and scale overshoot to 4%; its last 80ms crossfades to the destination's optical artwork. The background fades independently over 420ms and startup furniture over 160ms. The App itself is never scaled or faded.
- The handoff returns a cancel function which restores inline styles and interaction state, cancels animations and clears environment listeners/observers. Gate completion checks the current attempt and primary commits again. A missing or invisible destination uses a finite 200ms opacity fallback. Geometry changes, a hidden document or reduced motion finish the current valid presentation safely; revoked readiness instead cancels it and restores coverage. The overlay is inert while retiring, and the destination is hidden only until its final crossfade.
- Recovery uses a compact heading, a short human instruction and the applicable real actions. Raw error messages, stage/code/outcome, original migration/release/stop IDs and inspected owner facts belong to closed diagnostic disclosures. Lazy import rejection remains caught above App, including non-Error/falsy thrown values. An unavailable bridge or explicit failure phase must not show an endless activity animation.
- Legacy inspect/stop/reconcile remain explicit user actions after the one initial read-only inspection. Compacting their presentation must retain pending/unknown latches, exact identities, inspection prerequisite, disabled repeat/ordinary retry and read-only original-result reconciliation. The renderer releases an inspection latch after 20 seconds and ignores a late reply, so a stalled native check cannot leave exit/retry controls disabled or restart the bootstrap loop.

This presentation amendment was exercised in an isolated browser fixture importing the actual component: both themes at 1440/768/390, phase continuity and stale revision, reduced motion, pending lazy readiness, immediate workspace mount, error retry, missing bridge, legacy unknown/reconcile and rejected lazy chunk. The fixture has no native authority/profile/provider connection; this is visual/renderer evidence, not native lifecycle acceptance.

### Actual page readiness and continuous handoff

`daemon/StartupContext.tsx` owns renderer-only `StartupPresentation { initialTheme, register, changed }`, `StartupContentRegion({ identity, active?, children })` and `StartupContentCommit({ active? })`. These receipts never grant native authority or replace `BootstrapApi.attached`.

- Register visible regions outside their Suspense boundaries so a pending primary branch remains an explicit uncommitted region. The region effect registers only when `active` is true and returns its cleanup when the region becomes inactive; an inverted guard leaves the App mounted but keeps the startup cover permanently opaque. Put commit markers inside actual primary content, never its loading fallback. Region identity follows the real page/root/retained ACP owner/task surface; inactive retained sources do not hold or claim visible readiness. Distinct marker tokens prevent one cleanup from revoking another current marker in the same region.
- The normal page, active ACP source, and visible task preview/expanded task each participate as appropriate. Preserve retained reader instances and existing interaction scope; readiness registration must not remount the source. Terminal page/global ErrorBoundary fallback supplies a commit marker so recovery cannot remain covered indefinitely.
- `MainApp` does not expose Onboarding before `useApp.bootstrapped`. A completed legitimate no-project state commits Onboarding. App uses the presentation theme until Settings is authoritative, avoiding a default-theme flash during async bootstrap. Async bootstrap rejection is caught and rethrown on render into the restricted outer recovery boundary, including falsy rejection values.
- All active regions must have current primary commits, followed by two cancelable frames. Marker cleanup, Suspense hiding, route replacement or Gate cleanup revokes pending frame work. Until the initial reveal has fully completed, a newly pending active region also revokes an in-flight handoff: cancel its animations, restore the opaque cover and both mark owners, invalidate that attempt and wait for new primary receipts. Once fully revealed, ordinary navigation does not resurrect startup. During the handoff the App host is inert/aria-hidden; remove those after the cover retires without moving focus. Bounded visual cleanup is pinned to the current reveal attempt and rechecks its receipts; stale animation completion cannot finish another reveal. This cleanup is not a readiness source. Reduced motion skips travel and elastic docking.
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
