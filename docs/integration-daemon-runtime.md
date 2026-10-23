# Daemon Runtime and Desktop Quit

Incremental Agent lifecycle implementation. Bounded compilation, authentication, real idle-owner migration, actual desktop rendering and development startup have been exercised. Active-work/reconnect/stress/provider/packaging acceptance remains incomplete; this checkpoint does not archive the task.

## Execution boundary

`src/main/daemon/runtime/index.ts` reuses `services/acp.ts`, public acpx and the existing workflow application/controllers. Native IDs, runtime/profile snapshots, canonical leases, workflow command fences, archive material identities and permission resolvers remain in those implementations. There is no replacement ACP transport or prompt queue.

`createDaemonRuntime({epoch,directory,assertOwner,assertAuthority})` returns a typed, native-only domain:

- `dispatch(method,payload,{workspace?,commandId?})` invokes explicit allowlisted operations after the core's authenticated peer/epoch/grant validation.
- `status()` remains available during preparation and after release, reporting actual authority readiness, admission, owned sessions/workflows, pending operations and release.
- `pack(root,value)`/`unpack(root,wire)` share the blob RPC's single bounded spool for native provider-domain composition.
- `ownsWorkspace(root)` fences grant replacement/revocation using actual pending/native/controller ownership.
- `closeAdmission()`, `shutdown()`, `release()` close new admission, drain actual managed stages and canonical ACP/history, await outstanding operations and watcher close, and refuse release on failed cleanup.
- `observe(listener)`/`catchUp(root,cursor,limit)` deliver a bounded cache with epoch/gap detection. The existing ACP archive remains transcript authority.

Core composition must install native settings/integration state first and supply a real completed-cutover assertion. It must await runtime shutdown/release and its integration processing stop before releasing the daemon lease. Unknown remote effects remain unknown after local processing stops. Runtime disposal does not cancel or claim to undo a remote provider write.

## Native client and compatibility

GUI ACP IPC, workflow IPC, fixed-reader source checks and team publication reads use the typed native client adapters. Existing local ACP create/prompt/load/control/history/profile and workflow-controller entry points reject GUI execution. Synchronous local metadata readers are historical/local-owner projections; they cannot prove daemon ownership or idleness. The native task-conversation feature opens external native editors through its existing launch ports and does not create an ACP controller. Handoff generation remains read/copy only.

ACP knowledge and knowledge IPC also reuse a single daemon service. A narrow async workspace host carries the original MCP owner; the daemon never imports GUI state to choose a project. Root-scoped task creation is extracted from the existing creator and shared with GUI planning. UI knowledge scope edits and publications therefore use the same in-flight state and repositories as the native conversation. Local artifact images and OS document opening remain GUI native.

`workspace.get` reuses an existing retained grant on reopen. A new grant is requested only when absent. A GUI source predicate is rechecked after blob upload and before submission. Once admitted, the request retains its original root; changing the selected project neither retargets nor cancels it. Only the selected GUI root has a replay observer; detach closes GUI observers without changing daemon execution.

Profile-wide Agent discovery/setup/probe are authenticated native methods without a workspace. OS Node/CLI pickers remain GUI dialogs and pass selected configuration through the injected async settings writer. No additional settings cache exists.

## Bounded bulk and command outcomes

Control frames retain the foundation's 256 KiB limit. Inline runtime values are limited to 96 KiB. Opaque blob transfers use ordered 96 KiB decoded chunks, checked byte count/full SHA-256, an epoch and workspace/profile-bound native map, ten-minute expiry, at most sixteen transfers, a 128 MiB individual ceiling and 512 MiB aggregate spool. Read chunks do not load the full blob on each request. No caller-supplied filesystem path is accepted.

This path preserves the existing eight-image/10 MiB-per-image/20 MiB-decoded-total validation and untruncated pinned history/material results within the transfer ceiling. The existing image signature/capability/source/generation validators still run in the ACP facade. A result exceeding the bounded transfer ceiling fails visibly and requires a smaller archive page; it is never silently truncated.

Runtime mutation receipts persist a command digest before native dispatch, with dispatching/completed/unknown state. Reused IDs with different semantic bodies fail. Disconnects and daemon restart never automatically repeat a mutation. Receipts retain the original result wire reference; an expired blob requires inspection through the actual session/history/command, not recreation of the write. Runtime receipts have a visible two-thousand-record admission ceiling. They do not copy image input bytes into the small foundation job/command ledger.

## Approval and observation

The original daemon permission map owns option IDs/kinds, generation, turn and the 120-second deadline. No GUI subscriber is needed for the timer. Explicit deadline checking also rejects a response that arrives after expiry before a delayed timer callback runs. Historical metadata clears actionable pending approvals. Reconnect projects only current owned state and refreshes archive pages after a gap. Historical events never recreate a resolver.

Daemon root watchers continue material observation while the GUI is absent. GUI watchers retain UI reader/toast duties. Native timeline and material events have a single daemon writer. Filesystem events are verified through the existing material/path reader and do not assert Agent authorship or workflow completion.

## Quit and startup

Tray Exit invokes a dedicated frameless native confirmation window even when the panel is hidden. Its attempt ID and IPC responses are bound to that exact window/frame. The checkbox begins from saved `keepRunning` (true for a new profile). Cancel changes neither admission nor preference. Retain verifies the same daemon epoch/owner and exits the GUI after GUI-owned application/team cleanup; daemon work continues. Unchecked Exit invokes the verified core stop and waits for original process exit. Failed/unknown cleanup keeps the GUI available and offers retry/cancel with the error. Canonical ACP shutdown owns child cancellation/termination; no arbitrary PID can be supplied or adopted.

Startup preferences are `client`, `login`, `manual`. Client startup calls the existing native manager. Login status comes from actual registration verification. Manual avoids an implicit runtime-call launch. Settings exposes current status, retention/startup preferences, explicit start/stop/restart and bounded redacted log codes.

GUI first shows a restricted bootstrap shell using non-secret desktop preferences. Full Settings readers, feature IPC and desktop effects remain behind `prepareGuiNativeState()`, actual `native.ready` and read-only credential preparation. The coordinator binds the original release proof and migration IDs; it never creates another controller on retry. The release callback returns `{runtimeDrained:true,releaseId,admission:'closed',sessions:0,workflows:0,at}` only after actual cleanup. A prepared/unreadable fence cannot reopen legacy writes. Runtime picker/settings/HTTP preferences use `writeNativeSettings(patch)`; UI-only preferences use their separate synchronous writer.

Live same-install historical v10 owners keep the normal compatibility guard. The restricted shell offers explicit read-only historical inspection, idle/legacy-only exact-owner stop and original-stop reconciliation without key publication, lease deletion or forced termination. Only proven original process exit plus lease release permits normal new-owner startup. Known unsubmitted attempts retain `not-admitted`; submitted unknown attempts never create another stop UUID. Full process-restart recovery of an unknown attempt remains separate.

Ordinary native calls reuse a pooled authenticated connection. Workspace hints coalesce into snapshot/cursor replay with bounded health recovery; writes are not replayed. Cancellation/approval/stop use independent bounded control admission, including descriptor/grant/connection-bound reads of a large control acknowledgement. Reset snapshots must validate successfully before consuming their exact tail cursor or clearing unavailable state.

An already-running ordinary GUI still owns the GUI singleton when `npm run dev` is invoked. Duplicate launches print an explicit message and reveal the existing panel. To enter dev, finish GUI-owned cleanup while retaining the daemon before relaunching; a normal window close-to-tray does not necessarily release that singleton. The daemon does not need a restart for this handoff.

## Deferred validation

Completed bounded evidence includes compilation, genuine independent native authentication, read-only warm RPC reuse, synthetic historical compatibility, a real idle old-owner cutover with preserved configuration, full existing-project GUI rendering and actual development startup with the same retained daemon. Remaining gates include active-session/pending-permission reconnect, maximum bulk/history/material load, slow-reader/saturation behavior, hidden-tray dialog focus/layout, failure/unknown recovery across process restarts, login registration, provider effects and packaged role/worker loading. Full suites/typecheck/lint/packaging and live vendor writes/messages were not run; no full acceptance claim follows from this checkpoint.
