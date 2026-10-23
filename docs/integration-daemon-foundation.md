# Integration daemon foundation (protocol v1)

This is the independent host/control foundation and its current lifecycle/provider composition. ACP/workflow execution belongs to the daemon after verified settings/runtime cutover; merely starting a host does not transfer an existing live controller. This is an incremental implementation with the bounded validation described below, not complete provider/packaging acceptance.

## Entries and identity

`out/main/index.js` builds from `src/main/bootstrap.ts`. It resolves the role before loading any composition:

- GUI: independently built `gui.js` from the existing `src/main/index.ts`; existing GUI singleton and quit behavior remain in that module.
- Daemon: `daemon-host.js`, with native readiness, protected state and daemon-owned ACP/workflow/provider composition; no desktop window, tray, updater or GUI-global project authority.
- Control: `daemon-control.js`, another rendererless Electron process for native management and credential access.
- Console: `daemon-cli.js`, running in the shipped Electron's Node mode. It spawns the real control role and forwards bounded JSON/exit codes. No global Node installation or exported credential is required.

Installed Windows entry: `<installation>/resources/daemon/trellis-daemon.cmd daemon start|status|stop|restart|logs|preferences`. `set-preferences` takes one JSON argument `{revision,keepRunning,startup}`. The wrapper uses the current builder `productName` executable, `Trellis Panel.exe`, and unpacked `out/main/daemon-cli.js`. Keep those packaging paths synchronized if the product executable is renamed. The command is bundled; this change does not register it globally on PATH.

For development, the emitted CLI accepts `TRELLIS_DAEMON_DEV_APP` and `TRELLIS_DAEMON_EXECUTABLE` to select the same development app/runtime. These are executable/app paths, not credentials. Installed packaging behavior remains a separate acceptance gate.

Canonical existing Electron `userData`, application name and dev/prod identity are preserved. Separate role session directories do not share Electron safeStorage keys: current snapshots use a profile-scoped AES-GCM key wrapped by Windows CurrentUser DPAPI, while known historical v10 values have bounded read-only compatibility preparation. Original Local State files are never copied or overwritten to share keys. Identity hashes canonical userData, Windows SID and packaged/development mode; version and canonical installation must match. The daemon has a separate role lock, while GUI single-instance behavior remains independent.

Windows is the implemented native adapter. Missing Windows PowerShell, unsupported OS, denied process identity, unavailable safeStorage, incomplete/corrupt owner files or missing packaged resources return denied/unavailable/version errors. There is no insecure TCP or plaintext fallback.

## Public clients and boundaries

Shared import: `src/shared/daemon/index.ts`. Additive integration DTO import: `src/shared/integration-work.ts`. Existing `src/shared/integrations.ts` and provider-specific business contracts remain unchanged.

`DaemonApi` is exposed as `window.trellis.daemon` by preload. It has `protocolVersion: 1`, `status()`, `start()`, `stop()`, `restart()`, `preferences()`, `setPreferences(input)`, `logs({after?,limit?})`. Use `hasDaemonApi` as a feature guard. Until the separate shared-types owner adds the optional declaration, a renderer consumer can intersect `TrellisApi & {daemon?: DaemonApi}`. Missing preload/main support is an application-version problem, never a browser persistence fallback.

Management IPC is registered through `ipcInvoke.daemon` and the normal IPC registry. Only the actual native main window's main frame may call it. No credential, generic method invocation, workspace grant or arbitrary path endpoint is exposed to the renderer.

Native import: `src/main/services/daemon-client/index.ts`:

```ts
DaemonClient.connect(context): Promise<DaemonClient>
client.request<M extends DaemonMethod>(
  method: M,
  payload: DaemonPayload<M>,
  options?: {workspace?: WorkspaceGrant; commandId?: string}
): Promise<DaemonResult<DaemonData<M>>>
client.close(): void
observeDaemonWorkspace(context, workspace, observer): () => void
```

`createDaemonContext()` requires Electron readiness. Context/bootstrap credentials stay native-only. `daemonManager` implements the management facade and attaches to the verified owner. Start calls serialize within one client, and the OS role lock serializes separate GUI/CLI starters. Stop pins the original PID/start/SID/executable and waits for its actual exit; restart cannot proceed on an unconfirmed stop. It never signals an arbitrary process.

The explicit schema-paired allowlist is `daemonPayloads`/`daemonResults`: management, native state, workspace/events/jobs/commands, plus installed runtime/provider/bulk methods. Runtime authority and capabilities are reported from actual completed composition. A declared method without its installed owner fails unavailable.

## Transport and ownership

Control frames use a four-byte big-endian length followed by UTF-8 JSON. Current limits: 256 KiB/frame, 16 connections, 16 pending calls, 1 MiB pending bytes, 15-second request deadline, eight-second handshake, 100 events/page, 1,000 retained events, eight active jobs/workspace, 500 retained jobs and 2,000 command receipts. Ledger publication is capped at 8 MiB. Exhaustion rejects new admission; no retained command is silently evicted and later reexecuted.

The Windows transport creates a protected current-SID, local-only pipe before accepting connections. Its long-lived helper queries the client process identity, retains that process's kernel handle and closes the pipe on its exit. HMAC authentication pins this captured live identity, profile/mode/version/installation, epoch and fresh challenge; it does not claim a sampled PID proves the first pre-auth pipe opener. Each frame retains lifetime and lease/grant checks without spawning a new PowerShell verifier. Ordered bounded output queues isolate slow peers; ordinary requests, controls and authentication have separate bounded admission. Logs accept fixed codes only.

The lease records protocol/identity, owner PID/start/SID/executable, epoch and nonce. Actual process identity is checked before stale-owner recovery. Expiry or file absence is not proof of death. Missing lease contents in an existing owner directory fail closed. Lease release removes only the exact current record/directory. A verified live version/installation conflict never starts another controller or kills the old one.

Workspace grants carry native-authorized canonical root, workspace ID, UUID and revision. Every scoped call compares the complete current grant and resolves its root again. Provider admission captures original connection, binding and instance revisions; resolution must come from an `IntegrationAdmissionPort`, and the scheduler checks returned enabled connection identity. An assistant message is never a workspace grant.

## Durable work, checkpoints and replay

`DaemonRepository` atomically publishes a command digest/receipt, job/outbox intent, retained workspace admission and committed event. Canonical command identity excludes transport request/epoch so reconnect can inspect the original intent. Reusing an ID with another payload conflicts. A duplicate committed command returns its saved result without another provider authorization or write.

Jobs preserve source namespace, connection/binding revisions, command/job ID, input references, original owner epoch, counts and cursor. Each private retained admission also stores the actual dispatch owner's PID/start/SID/executable (`admittedOwner(jobId)`), so repeated restarts do not erase cleanup/reconciliation identity. Dispatch is committed before an adapter runs. Restart converts dispatched/running/cancel-requested work to `unknown`; it never returns it to queued. Unknown work fences the affected workspace/connection. Active snapshots contain at most eight active/unknown jobs; completed history uses `jobs.list` pages. `commands.get` can return redacted receipt metadata to an authenticated native client even after a workspace grant was revoked; reading job data still needs a current grant.

Native progress API:

```ts
repository.checkpoint(jobId, expectedRevision, originalOwnerEpoch,
  {cursor, counts: {processed, failed, total}}, retainedEvidenceRef): IntegrationJob
```

Checkpointing keeps lifecycle state, increments revision, commits an event and requires the exact owner/revision and an executing/cancelling state. Processed means visited records including failed records: `failed <= processed <= total` when total is known. Processed/failed cannot decrease; a known total cannot change; a retained cursor cannot be erased. Provider-specific cursor ordering/coverage belongs to its adapter. `IntegrationWorkPort.dispatch` receives this checkpoint callback. Its settlement uses the latest retained job revision after progress or cancellation. Cancellation can finish admitted work but cannot admit new items. Unknown effects need explicit evidence-based reconciliation.

`IntegrationScheduler` uses the existing registry and native `work`, `accounts` and `sync` ports. The default application composition installs the Jira, GitLab and DingTalk domains after protected authority is ready; `runDaemonHost({integrations: settingsOwner => ({registry,admission})})` remains a trusted override seam. Workers retain exact grants and provider revisions rather than GUI selection. Optional polling failures do not starve unrelated scheduling or native cleanup; unconfigured DingTalk does not start SDK/timer work.

Main's `services/integrations/workspace-host.ts` is the reusable workspace seam. Install one daemon host backed by authenticated request/job async context, using retained root/snapshot authority. Do not switch this singleton per job or reuse GUI-global selection as worker authority. The main-owned GUI installer continues to use its own selected project.

Events identify `(epoch,committedSequence)`. Snapshots establish a catch-up cursor. Replay is workspace-filtered and bounded; epoch mismatch, future cursor or retention gaps return reset-required. Native observer helpers retry only read/attach operations, at bounded backoff, and never repeat mutations. Closing a client/observer does not cancel admitted work. The local repository observer publishes only after durable publication.

## Protected settings and staged authority

`ProtectedSettingsOwner` is the native single-writer repository; credential operations retain keep/replace/clear and callback-scoped native decryption. Public integration snapshots expose neither stored ciphertext nor plaintext credentials. The shared profile key is atomically published without replacement only by the acquired owner. Actual historical Settings/connection secrets are authenticated and normalized before synchronous service admission, retaining public IDs/revisions and original recovery evidence.

The lifecycle coordinator supplies an actual legacy drain/release proof to `native.prepare`; an ordinary renderer cannot invoke arbitrary migration. `migrate({commandId,legacyOwner}, drain)` validates bounded legacy Settings/integration schemas, preserves unknown values and source files, and pins source hashes. One canonical `userData/daemon-v1/settings-owner.json` checkpoint fences legacy writers across modes before the protected original/new state is published. Source digests, actor and exclusivity are rechecked; interrupted preparation retains the original command and fence. Settings phase alone is insufficient: `native.ready` must confirm actual protected/runtime preparation before full desktop admission.

The old settings store and integration repository check this fence before writes, including implicit legacy migration. There is no second daemon cache writing legacy files. Without a completed lifecycle broker, fenced legacy setters explicitly fail; this foundation never enables migration by itself. ACP metadata, history, runtime installations and project control databases are not copied or adopted here.

Upgrade/rollback handshake: drain and verify the original owner; reconcile unknown native/provider effects; take the protected checkpoint; install compatible callers; then switch admission. Rollback first stops/reconciles the actual daemon and disables its native login entry, verifies no retained dispatched/unknown work, and only then restores legacy authority from a reviewed checkpoint. Deleting a lock/checkpoint while an owner may still run is not rollback. Automatic downgrade/unfreezing is deliberately absent.

Startup preferences default to `keepRunning=true`, `startup=client`. GUI retain/quit and actual client-start policy are wired by the lifecycle child. Windows login startup is opt-in through an independent named per-profile login entry; development returns unavailable for that mode. Native registration has a persisted unknown command intent before registry mutation and commits saved preferences only after exact native verification. An interrupted registry operation is not blindly repeated; `startupRegistration`/`startupCommandId` show uncertainty, and `reconcileStartup` requires verifying the original entry. It does not overwrite the existing GUI autoStart registration.

## Deliberate bulk-transport handoff

The 256 KiB control cap is not the ACP attachment/history limit. Existing ACP accepts eight images, 10 MiB/image and 20 MiB decoded total (`src/shared/acp-images.ts`); history/material pages can exceed a control frame. Lifecycle must reuse the existing ACP facade and inject its event sink, keeping those capabilities intact.

Runtime implements a bounded authenticated blob spool for ACP/history/material/provider bodies, with exact root/epoch, declared byte count/digest, ordered chunks, quotas, expiry and explicit release. See [runtime transport](integration-daemon-runtime.md). Incomplete/stale/cross-root references fail; there is no arbitrary filesystem endpoint or silently truncated history. Active transfer/stress acceptance remains separate from successful ordinary startup.

## Bounded validation and remaining work

Current-source temporary compilation, independent new-format authentication/warm RPC, synthetic v10 compatibility, a real idle historical-owner cutover/configuration migration, full existing-project desktop startup and canonical `npm run dev` startup have been exercised. The real workspace retained its task/archive records and the daemon survived GUI-only dev handoff. No full test/typecheck/lint/stress suite, packaged installation, active-work upgrade, vendor mutation or notification delivery is claimed. The task remains in progress; no archive is implied by this checkpoint.

## Verification status

Performed: source/diff/import/path/authority review only. No tests, typecheck, lint, builds, packaging, process launches/stops, login registration, provider consent, application registration, credential probes or messages were executed.

Deferred gates include Windows ACL/actual peer PID enforcement, concurrent GUI/CLI start, PID reuse/version conflict, real safeStorage and migration interruption, native stdout/exit codes and Unicode installed paths, role bundle isolation/watch rebuild, packaged CLI/resource/asar paths, login registration/reconciliation, GUI-exit daemon survival, power-loss durability, unknown provider effects, large ACP/history transfer and later runtime cutover. The parent acceptance remains open for those and all dependent-child behavior.
