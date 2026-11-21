# Desktop restart and upgrade lifecycle

## Scope and triggers

Applies to explicit development launches, changed-build replacement, backend restart and Windows installer maintenance. Ordinary same-build attachment preserves the original epoch and execution. Normal GUI exit retains its separate background preference.

`npm run dev` is an explicit development restart. An existing GUI must complete handoff before the new GUI acquires the single-instance lock. Renderer HMR never requests backend replacement.

## Signatures

- `runDaemonLifecycle(context, options): Promise<LifecycleAttempt>` coordinates one durable original-owner exit.
- `stopDaemonForLifecycle(options)` supplies the current build and configured confirmation to that coordinator.
- `prepareDaemonTermination(context, lease)` and `prepareGuiTermination(context)` capture exact native scopes without terminating them.
- `DaemonTermination` exposes `arm(graceMs, timeoutMs)`, `disarm()`, `terminate(timeoutMs)`, `verify(timeoutMs)` and `dispose()`.
- `daemon.status` adds optional `lifecycleVersion: 1`, `activity` and admitted lifecycle identity. Older status remains readable; missing activity requires confirmation rather than an idle assumption.
- `daemon.lifecycle.admit` fences new work and atomically checks whether a lifecycle stop may proceed without interrupting a conversation.
- `daemon.lifecycle.resolve({expectedOwner, nonce, attemptId, admissionId})` confirms that admission or retires its delayed request before reporting `not-admitted`; a status snapshot alone cannot exclude a late frame.
- The maintenance role accepts one `--trellis-target-install=<path>` and optional `--trellis-maintenance-silent`. Exit codes are 0 for verified release, 2 for cancellation/required interaction and 3 for failure.
- New installation maintenance can write `--trellis-maintenance-receipt=<TEMP-subdirectory>/crux-lifecycle-receipt.txt`. The original uninstaller receives `--trellis-maintenance-reconcile=<attemptId>:<targetSHA>` and only verifies that exact released handoff.

## Contracts

`CRUX_DEV_LAUNCH_ID`, `CRUX_DEV_LAUNCH_PID` and `CRUX_DEV_LAUNCH_ROOT` bind a development launch to its live launcher and installation. Repeated main rebuilds consume the same completed launch only while the target build is unchanged. Do not forward these variables to the daemon or execution children.

Branded development hosts can change executable paths between builds. GUI
discovery accepts at most three canonical, deduplicated executable paths: the
current host, the protected same-install/profile/mode/SID GUI owner, and the
same-scoped original daemon lease. A live daemon hint also proves its exact
generation, daemon role, application path and profile. A historical exited lease
supplies only a bounded path hint; each GUI still requires independent native
identity, role and profile proof. Compare physical executable paths, including
Windows short-path aliases; process names never authorize discovery or termination.

Activity comes from actual `OwnedAcpSessionFacts`, not historical status or connection counts. A healthy ready connection is idle. Admitting/running turns, pending permission, unfinished tools, background work and unsettled leases require interruption consent. Disconnection and unknown cleanup require a warning that a conversation may be interrupted. Non-conversation integration/application work is cancelled with the restart and does not independently require conversation consent.

Confirmation cancellation submits no stop. A successful atomic idle admission already owns the shutdown transition: a lost admission reply must be reconciled with its original command/attempt identity, never presented as a harmless cancelled request. Confirmation binds the original owner/epoch; it cannot authorize stopping a successor.

The protected `lifecycle-attempt.json` retains attempt, admission and stop command identities, target lease, controller, launch, confirmation, submission state and phase. Concurrent callers join the same target attempt. An uncertain mutation is observed through its original receipt, not replayed under a new UUID.

All cleanup shares a 15-second grace, followed by at most 10 seconds of native termination/verification and 5 seconds for release publication. Native watchdog setup and disposal must also be bounded. The user confirmation interval and subsequent successor startup are separate. A deadline cannot imply process exit.

New daemons use a generation-specific Windows Job with an independent guardian and no breakaway. Native controllers retain checked kernel handles and Job witnesses across the entire operation. Legacy scopes require original launch evidence and exact helper identities; discovering a PID alone never authorizes termination. Failed partial capture disposes every successful controller.

Native inspection returns `bootStartedAt` from Windows kernel
`SystemTimeOfDayInformation`. If the protected original owner's positive creation
ticks precede this boot, the original process tree cannot still exist. The native
controller rechecks the boot witness and current Windows user, reports
`exitedBeforeBoot: true`, and opens no original PID, helper or Job. Reused PIDs
belonging to the new boot are never termination targets. This applies to both
legacy and contained daemon records and stale registered GUI owners. A missing
same-boot legacy capture still blocks replacement; an estimated wall-clock boot
time or a missing PID alone cannot establish exit.

The coordinator uses this native fact to reconcile the original attempt and
lease without requesting interruption consent or replaying stop against the dead
daemon. A remaining live GUI still requires its own capture and confirmation.
Publish the normal original exit receipt and retain unknown business effects;
a system reboot proves local process exit, not external operation success.

Only explicit consent or authoritative idle admission arms termination. Unarmed cancellation/disposal must not kill anything. Once armed, an unresponsive application event loop cannot prevent native escalation. Query the original execution scope and helpers after termination; a dead root PID alone is insufficient.

A process can exit between the Job termination and a direct helper termination.
Reconcile such failures against the retained handle and Job accounting;
an observed exit is success, while access denied with a still-live process is
not. Canonicalize executable paths before comparing native evidence because
Windows short and long path forms can name the same executable.

Publish original exit evidence before stale lease recovery. Both manager startup and lease acquisition respect the lifecycle fence until scope verification and release complete. Do not delete owner/state/credentials to escape that fence. Preserve conversation history and unknown external side effects; restarting never resends a prompt or business request.

The NSIS `customCheckAppRunning` hook must run before uninstall/overwrite. It invokes maintenance from the extracted new package so the first upgrade does not depend on a lifecycle feature in the old executable. Cancellation or failure stops installation. Silent installation does not silently approve an uncertain or active conversation. Do not use the post-copy `customInstall` hook for this gate.

A genuinely new upgrade selects its own successor fingerprint even when no
daemon has started since the preceding upgrade. An interrupted stop retains its
original stop identities while adopting the new successor target. The original
uninstaller may verify the 101-character `attemptId:targetSHA` receipt, but cannot
create a replacement attempt, stop a new owner or revert the target fingerprint.


GUI startup uses an internal `gui-launcher` role and a protected
`--trellis-gui-contained=<nonce>` handoff. The native guardian creates the real
GUI suspended inside `Global\CruxGui-<nonce>`, publishes its proof before resume,
and watches the exact developer launcher handle. IDE termination therefore
cleans the original GUI scope even before a successor starts. The headless
launcher has separate sessionData and never acquires the GUI instance lock;
only the contained root loads desktop composition after native membership checks.
GUI creation preserves ordinary first-window visibility. Debugger arguments
belong to the real GUI, not the launcher.

The GUI Job permits the fixed daemon launcher to break away; that daemon is
immediately created under its separate non-breakaway Job. GUI exit does not
imply daemon exit. A new authenticated development launch stops the original
daemon by its own owner/epoch and verifies its complete native scope.

For a registered legacy GUI whose exact root has exited without a startup Job
or retained capture, only authenticated development restart may reconcile its
registered managed jobs and preserve unrecorded descendants as `unknown`.
`prepareGuiTermination(context, {recoverExitedLegacy: true})` exposes that narrow
policy; installation maintenance leaves it disabled. The attempt records
`legacyGuiRecovery` with original owner, `unmanagedDescendants: unknown`, and
managed cleanup state. Verification writes an original-owner history receipt;
it does not authorize terminating unidentified descendants or replaying effects.
A cancelled pre-lock development launch exits before publishing another GUI
owner, preserving the original recovery target.

## Validation and error matrix

| Condition | Required result |
| --- | --- |
| Same build, ordinary GUI reopen, active turn | Attach original epoch without cancellation |
| New development launch, idle persistent session | Release old GUI/backend, then launch successor |
| Active or uncertain conversation | Confirm once; cancellation preserves original execution |
| Session starts during an idle check | Atomic admission refuses interruption and requests consent |
| Admission acknowledgement lost | Observe original admission; do not cancel an already-admitted exit |
| Stop RPC or application event loop hangs | Native watchdog enforces the original bounded exit |
| PID reused, other installation or other Windows user | Reject without terminating the other process |
| One native scope capture fails | Dispose all captured controllers; no orphan watchdog |
| Controller crashes or reply is lost | Keep original attempt and scope evidence; reconcile before succession |
| Old root exits while descendants remain | Continue scope cleanup; no successor or installer overwrite |
| Installer cancellation or incomplete verification | Nonzero maintenance result; original files not overwritten |

## Cases

Good: an idle connection is released automatically; a running response receives one confirmation and completes the same durable stop after a dropped reply.

Base: ordinary close preserves the user's background preference and later same-build attachment.

Bad: interpreting every connected session as active work, changing only the error copy, using image-name kills, or marking a stuck process stopped because a timer expired.

## Required verification

Run actual independent GUI/control/daemon processes in isolated TEMP profiles. Exercise legacy first migration, same-build attachment, active-session cancellation/confirmation, idle admission races, suspended daemon watchdog termination, descendant coverage and duplicate callers. Validate NSIS pre-overwrite ordering with an isolated installation; static compilation alone is not installation acceptance.

Start the emitted daemon role directly as well as through the controller.
Shared lease schemas must live in the dependency-only `lease-schema.ts` module;
build identity and lifecycle fences cannot initialize a schema through a
lease→fence→build-identity→lease cycle. Type checking does not detect a Zod shape
capturing an undefined schema during CommonJS evaluation.

Run `check:acpx`, `typecheck`, `check:ui`, `build` and applicable packaging. Keep fixtures, process scripts, screenshots and reports in OS TEMP, never staged or committed. Record static, simulated-protocol and actual OS observations separately.

Real installer acceptance that writes registration or removes an installation
must use a disposable Windows user or virtual machine. A TEMP installation path
and application profile do not isolate HKCU registrations, shortcuts or updater
caches. Never run test registry cleanup against the daily Windows user. Scope
temporary filesystem cleanup to a nonempty canonical path and verified fixture
ownership; abort on validation errors. In PowerShell, use task-specific variables
such as `$lifecycleRegistrations`, never `$Matches`, which regex operators overwrite.

## Wrong and correct

ACP job owner replacement may opt into bounded Windows EPERM/EBUSY/EACCES rename
retries at 5, 10, 20 and 40ms. Keep the synchronous durable write before spawn.
Never unlink the original owner file to make replacement succeed. Commit the
launch ID list before mutating the in-memory owner or spawning a transport.
A late witness cannot promote a cleaned or closing job to running. Persistent
replacement failure preserves ownership and rejects launch.

Wrong: check `blockers.length` before same-build attachment, then infer that an existing connection must finish before the application can update.

Correct: distinguish attach from replacement, classify current conversation activity, obtain consent where needed, and verify exact-owner exit before replacement.
