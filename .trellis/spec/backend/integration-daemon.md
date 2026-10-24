# Integration Daemon Contracts

## Scope / Trigger

Applies to `src/main/daemon`, native daemon clients, integration workspaces and quit behavior. These contracts describe the current source implementation. The user approved a bounded 2026-10-23 exception for temporary compilation, blank-profile independent host/client and restricted bootstrap UI diagnosis. It does not authorize full test/typecheck/lint/build/packaging, real desktop/daemon restart, existing-profile migration, live provider operations or commits. Full native/provider/visual acceptance remains open.

The user subsequently explicitly approved the real idle historical-owner cutover and desktop recovery. That narrower real incident was executed successfully: original40848 authenticated as idle/legacy and stopped canonically, normal new owner migrated retained configuration, and actual GUI33368 opened the original56-task/34-archive workspace against native-ready daemon43100. See lifecycle `research/legacy-owner-real-recovery-result.md`. This approval/result does not generalize to active-work/cross-install upgrades, provider business writes, full stress/packaging or commits.

Development handoff: an ordinary GUI retained after recovery still owns the same GUI single-instance lock used by `npm run dev`. Losing that lock must print a fixed explanation and keep the existing exit behavior; do not remove the lock or stop the independent daemon to make development launch work. Ready second-instance requests use `showMain()` to restore/show/focus the existing main panel. The installed electron-vite lifecycle ends its command when its spawned Electron child closes; an exit0 duplicate launch is not a compiler crash. To switch an already-running ordinary GUI to dev, finish GUI-owned cleanup while retaining the daemon, then launch dev. When verifying for a user who will run their own terminal, release the verification GUI/server/port instead of leaving another conflicting instance. Actual canonical startup/duplicate/retained-daemon evidence: lifecycle `research/dev-start-verification.md`.

The bootstrap loads `./gui.js`, `./daemon-host.js` and `./daemon-control.js` as sibling **output** bundles emitted by `bundleMainRole` in `closeBundle`. Use `createRequire(__filename)` and invoke its native loader only inside the selected role branch; this avoids relying on a bundler's lowering of direct conditional `require` calls. Keep these exact IDs external in the bootstrap main build. Direct source resolution would otherwise fail with `UNRESOLVED_IMPORT` before the role-output hooks run. Preserve relative CJS runtime paths and separate role bundles; do not add placeholder files under `src/main`, accept arbitrary loader paths from argv, or externalize all relative source imports.

Windows native helpers run the fixed Windows PowerShell executable and reset their process-local `PSModulePath` to `$PSHOME/Modules` before module auto-loading. A GUI launched through PowerShell 7 can otherwise inherit incompatible Core module paths; the observed result was `CommandNotFoundException` in directory protection before lease creation. Never fix command resolution by relaxing ACLs. For an already-owned directory, modify only its DACL and verify the resulting owner/current-user-only full-control rule; ownership mismatch fails closed.

Startup must observe child `error` and `exit`, retain sanitized stderr, and distinguish early exit from a still-unconfirmed live owner. Bootstrap handles both role-module load exceptions and async entry failure. The GUI readiness chain has a terminal catch. If the restricted shell exists, retain it with a sanitized error; otherwise report the window-creation failure. Native preparation errors never stop a retained daemon or restore legacy writers.

On 2026-10-23 the user separately authorized isolated blank-profile startup diagnostics. Existing output-module loading passed; the failing startup captured a native `secure-directory` command-resolution error. With process-local module-path isolation, blank-profile host startup and **same-process** status succeeded. A subsequent separate-process client failed to decrypt the native credential: Electron's role-specific Local State keys are different. That failure invalidates a cross-process success claim. Shared protection and the later startup optimizations are source changes awaiting separately authorized compilation/native acceptance; existing output bundles do not validate them.

## Signatures

- `createGuiBootstrap(ports)` owns the restricted shell state machine (`window-ready`, `connecting`, `preparing`, `ready`, `error`, `incompatible`). The first main window reads only `desktop-preferences.json` for appearance. Only main-frame bootstrap status/retry/rendered/paint/minimize/maximize/own-GUI-exit IPC is registered before native readiness. Full feature IPC, legacy settings reads, observers and OS preference effects remain behind native preparation. Auxiliary windows keep their existing modes.
- `prepareGuiNativeState(onPreparing?, onAuthenticated?): Promise<void>` runs before full GUI settings, observers or admission, after the shell has committed and the window is visible. It drains the real legacy ACP/workflow owners and installs immutable legacy settings/integration readers before publishing native release evidence. A rejected attempt can retry with the same original release/command UUIDs; one-shot desktop installation cannot register handlers twice after partial failure.
- `DaemonNativeState.prepare(): Promise<void>` must be awaited before `initialize()` and `install()`. It prepares only legacy keys required by actual v10 data and authenticates/normalizes retained protected secrets under the owner/CAS fence. Connection and provider revisions remain unchanged by envelope normalization.
- `native.ready({}) -> { ready: true }` is a native-only, coalesced application readiness barrier. Settings phase `daemon` alone is insufficient. Online GUI preparation must await it after either migration or attach; it retries pre-install preparation under the original owner, never replays migration. Once port/controller composition has begun, partial failure remains non-retryable in-process.
- `prepareGuiNativeProjection(context)` authenticates the actual known encrypted Settings fields before GUI-local consumers are enabled, also in manual/absent mode. It reads the common projection, checks its revision/content after awaits, and prepares historical keys read-only. It never writes runtime state, opens provider connection secrets/ledgers or starts a daemon to satisfy manual mode.
- `NativeProtection.refresh()` coalesces/caches immutable per-profile key unwraps. `prepare(ciphertext)` loads historical Local State keys only when actual v10 ciphertext needs them. `TPD1` uses AES-256-GCM/profile AAD with an atomically published no-replace CurrentUser-DPAPI-wrapped key, independent of Electron role Local State. Existing keys/credentials cannot be reset or replaced on timeout.
- `ProtectedSettingsOwner.migrate({ commandId, legacyOwner }, drain)` adopts settings only with original source hashes and verified release evidence. A live owner requires the actual authenticated pipe actor to match the original released process.
- `DaemonClient.request(method, payload, { workspace?, commandId? })` returns `DaemonResult<T>`. Mutations preserve original UUIDs; disconnection never implies cancellation or permission to repeat them.
- `daemonConnectionPool(context).get()` coalesces one ordinary authenticated connection per profile/installation/epoch; ordinary callers never close that shared client. Lease/owner changes and native disconnect invalidate it. `disposeDaemonPools()` closes desktop sockets/observations without cancelling admitted backend work. Stop/cancel/permission controls use dedicated connections and a separate bounded server budget.
- `events.subscribe({})` / `events.unsubscribe({})` require the exact authenticated workspace grant and are connection-local. An `invalidation` hint carries only `epoch`, `workspaceId` and source `runtime|integration`; observers subscribe before snapshot/cursor replay and obtain actual data through the existing schemas.
- `createHistoricalControlContext()` is a separate native-only read context for the same installed version/path's live v10 owner with no shared key. It reads existing canonical paths and pins the complete lease/credential; no directory creation/ACL repair, global storage/Settings ports, key publication/reseal, lease acquisition/removal or migration. `createDaemonContext()` retains its normal historical-owner `E_VERSION` refusal.
- `inspectLegacyDaemon()` returns only `{epoch,owner,activeJobs,unknownJobs,runtimeAuthority,settingsAuthority,canStop}` after existing native peer/HMAC authentication. `stopLegacyDaemon({epoch,owner})` requires that capture, fresh exact-owner status, zero active/unknown jobs, legacy runtime/Settings, no migration evidence and old foundation capability. One retained command UUID owns concurrent/uncertain stop. Only the old owner performs stop and lease release; the facade never kills/replaces it or starts a successor.
- `reconcileLegacyDaemonStop({epoch,owner})` only observes/joins an existing original stop attempt. It cannot create an attempt, dispatch stop, change IDs, start or migrate. A truthful stopped result needs both original process exit and owner-side lease release. Bootstrap exposes these three typed management actions only to the guarded main frame during native-stage `E_VERSION`; ordinary Retry never stops an owner. The full GUI remains gated until normal new-owner preparation succeeds.
- `nativeDomainCall(root, method, body, commandId?, isCurrent?)` is native-only. Feature IPC exposes explicit typed methods; preload never exposes generic RPC.
- `DaemonWorkspaceScope.capture(expectedRoot)` returns the actual authenticated grant; `assert(grant)` rechecks identity, revision and physical root. Background work supplies its retained grant, never GUI current-project state.
- `ProviderDomain.add(method, requestSchema, resultSchema, action)` registers literal schema-paired feature functions. The composition root installs provider ports in the existing connector registry.
- `provider.read.cancel({method, namespaceId, requestId})` is a native-only, static transient allowlist. The private controls bind to the authenticated process generation and exact grant; cancellation uses a separate authenticated connection and acknowledges a request rather than claiming stopped jobs or revoked consent.
- `withWorkspaceChange(grant, change)` closes native admission before checking original runtime ownership, then performs the synchronous grant replacement/revocation under that lock. Pending effects and managed workflows block destructive ownership changes. Rollback also checks physical session cwd; foreign-project sessions using the target directory count as owners.

## Request / Response / Storage Contracts

The control frame is capped at 256 KiB. Runtime and provider bodies share the same owner-scoped `RuntimeBlobs` transport, including existing ACP image payloads. Validate the business schema after unpacking and before packing results. Never increase the frame cap to accommodate images or truncate history silently.

Server ordinary admission is 16 calls/1 MiB; reserved allowlisted controls use 4 calls/256 KiB and authentication has its own 16-connection/128 KiB budget. Workspace lookup and native status belong to the bounded control prerequisites; arbitrary provider work cannot claim this lane. Legacy integration cancellation is admitted only after parsing an inline `cancelRead|cancelAuthorization` body, with all normal actor/grant checks retained. No lane retries commands. Windows helper outgoing queues are ordered per peer, capped at 32 frames/1 MiB each and 4 MiB in aggregate; one peer's five-second write timeout must not block other peers.

The long-lived Windows pipe helper queries SID/executable/creation time, retains the queried process's kernel handle before emitting the challenge and closes its pipe when that process exits. Authentication binds the fresh HMAC challenge to this exact retained live process identity. A post-accept timestamp is only an additional fence; it does not prove the identity of the first pipe opener before the handle was captured. Do not describe this as a PID TTL cache or a complete initial-opener anti-spoof proof. Authenticated request/chunk handling does not spawn PowerShell/CIM for each call; lease/epoch/root/grant validation still applies.

Push hints are coalesced for 25 ms and bounded to two source entries per subscribed workspace (at most 100 per server peer). Client replay drains at most four 100-event pages before yielding; missed hints are repaired through a 15-second health replay, old capability-missing hosts through one-second polling. Reconnect backs off 1/2/4/8/15 seconds and restores only original read/subscription state. Never mint a replacement revoked grant, reconstruct a permission resolver or extend its deadline during replay.

An authenticated `E_BUSY` with `outcome: not-admitted` is backpressure, not proof of transport loss. Keep the connected observer's exact grant, cursor and subscription, retain one invalidation intent, and respect bounded retry backoff even when hints continue. A rejected unsubscribe may retry only its original connection-local subscription; it must not close a shared socket and make already-admitted commands uncertain. Real disconnection, changed epochs and revoked grants still invalidate the original attachment. Read errors do not acquire fabricated mutation command IDs; actual mutations retain their original UUID and outcome, with no automatic replay.

Filter ordinary project watcher paths outside `.trellis/` before sending Runtime watcher notifications over the shared socket. The daemon retains authoritative path/document checks. Renderer history invalidations coalesce into one in-flight list plus a trailing latest-state read; selected-session metadata and event pages share the existing serialized hydration queue and discard stale selections before dispatch. Do not raise admission limits to compensate for duplicate producers. Regression: `scripts/smoke/daemon-client-reads.mjs` uses an isolated authenticated pipe, delayed history reads, saturation, observer backoff and actual disconnect/epoch boundaries.

Runtime reset snapshots must be successful before the client consumes their cursor. A failed inventory is unavailable, not an empty successful reset. Pair a synchronous reset snapshot with the captured current tail; discard all superseded deltas and resume strictly after that tail. Never combine a current snapshot with the earlier hundredth-event page cursor after an oversized-event reset marker.

Optional workers start only when retained enabled work needs them. Unconfigured DingTalk does not create a timer/SDK transport; protected ledger reads are cached behind file-identity/size/time checks and invalidated after writes. Jira evidence loads on first use. Provider poll failures must not prevent other provider polls or the common scheduler from being serviced. These are bounded source optimizations, not acceptance of corrupted provider state.

DingTalk prior-process reconciliation is a separate synchronous one-shot barrier, before any new feature effect or Stream/timer activation. Lazy activation must not recover a current-process in-flight send as a prior-run unknown delivery. Poll failure during shutdown is reported separately and does not skip attempting actual Runtime cleanup; failed real cleanup still retains unknown ownership and refuses stopped acknowledgement.

`native.state` returns phase/revision/profile metadata only. `native.prepare` uses a release UUID plus the original mutation command ID; native release evidence is OS protected and binds source hashes, process generation and profile. `native.settings.write` uses expected protected revision and an explicit settings patch. Snapshot publication and settings command receipts share one protected write.

GUI owns only separate desktop preferences (`recentProjects`, `theme`, `desktop`). Runtime/integration state has one protected daemon writer. Source files and migration originals remain available for recovery. A prepared or corrupt checkpoint never permits fallback legacy writes.

Validate known settings field types before durable publication. Default-derived schemas cannot infer optional fields or typed empty arrays: explicit ACP agent/args/native-path/automation schemas, provider/model collections, string recent-project arrays and theme enums supplement that validation. Unknown extension keys remain compatible. A malformed `acp.agents` scalar must fail before the protected snapshot/receipt changes.

Native authorization waits allow five minutes. Current-project checks run before grant creation and immediately before effect submission after awaits. Original read/authorization cancellation remains available during GUI admission closure. Common integration read-result blobs are released by business operation classification. Mutation failures preserve the original command UUID in the feature error text; `native.provider.command` inspects its root/profile-scoped retained receipt.

The scheduler persists admission and dispatch before provider effects. Provider receipts retain external identity, mapping revisions, local baselines and unknown outcomes. Jira Server REST v2 and GitLab legacy repository/PAT/OAuth paths remain adapter implementations; presentation entries do not create duplicate provider identities.

## Validation and Error Matrix

| Condition | Required behavior |
| --- | --- |
| Epoch, profile, process generation, physical root or grant changed | Reject with conflict/denied; no replacement owner |
| Native preparation incomplete | Runtime authority remains legacy; execution unavailable |
| Backend/key unavailable before full desktop readiness | Keep restricted shell, show sanitized stage/code and original migration IDs; retry only native preparation |
| Partial full desktop IPC installation fails | Show non-retryable desktop failure; do not register handlers a second time |
| Live owner lacks `native-protection` capability | Explicit incompatible error before migration; preserve original owner and credentials |
| Same-install live historical v10 owner blocks normal control | Offer explicit bounded historical inspection and idle-only original-owner stop; no general startup guard bypass |
| Historical stop acknowledgement is unknown | Preserve original command/target; explicit reconciliation only observes original exit/lease, never repeats stop under a new ID |
| Shared key changes/disappears after caching | Close cached protection authority; no alternate key/plaintext fallback |
| Ordinary admission is saturated | Bounded auth/control lane remains independently admissible |
| Mutating acknowledgement lost | Retain original command ID and unknown outcome; inspect receipts |
| Same command ID with another payload | Reject conflict |
| Legacy writer after prepared fence | Reject unavailable; preserve files |
| Configured Stream proxy without a compatible socket adapter | Block Stream; never silently connect directly |
| No reachable callback service | Disclose unavailable personal OAuth/link-preview capability |
| Provider method declared but uninstalled | Reject unavailable; never return undefined success |

## Good / Base / Bad Cases

Good: GUI exits with retention selected while the authenticated daemon continues the original sessions. Reopening observes original session/command identities.

Base: a new installation defaults to client-triggered daemon startup and retention. Login startup is separate and explicit; persisted manual startup is respected.

Bad: adopting a running GUI's settings based only on its PID, starting a second ACP controller in the renderer host, or interpreting a catalog capability as verified provider permission.

## Required Acceptance Assertions

When separately authorized: verify Windows pipe ACL/authentication and epoch replacement; crash each migration publication boundary; reconnect across GUI exit without duplicate sessions; retain 20 MiB ACP image inputs through bulk frames; preserve permission deadlines; stop exact original owners before acknowledging exit; exercise settings CAS and lost replies; import 1,733+ Jira records beyond preview sampling; verify Stream dedup-before-ACK and no duplicate execution; visually inspect focus, dialogs, narrow layout and light/dark UI.

Startup acceptance additionally requires independent GUI/daemon/control processes with separate role sessionData, shared-key unwrap and legacy-key recovery, ordinary saturation plus cancellation, slow-reader isolation, same-epoch/changed-epoch replay, and actual process exit after inherited pipe-handle transfer. Record main monotonic first-visible/authenticated/native-ready/full-desktop-ready separately from renderer-navigation first-paint and its receipt time. Compare cold and already-running daemon cases; an earlier shell alone does not prove full-ready speed.

The bounded current-source compilation succeeded for the five main roles, preload and actual renderer. A blank-profile independent daemon/client confirmed shared-key authentication and six warm same-connection status calls (about 1.4–2.2 ms in that fixture) with unchanged native-helper launch counts; readonly management calls and wrong-owner stop rejection also passed. Restricted UI diagnosis confirmed show/paint before delayed preparation, error/retry/exit and before-ready attachment denial with full desktop composition count zero. These observations are **not** full desktop latency, existing-profile migration, provider, saturation/slow-reader, legacy recovery or complete native acceptance. Exact logs, source hashes and original-owner exit results belong to lifecycle `research/startup-executable-verification.md` and `startup-ui-executable.md`.

Protected Jira rollback must close workspace admission before checking runtime ownership. It rejects active sessions/workflows/provider commands and active or unknown jobs, then uses exact-job local provenance, unchanged artifact fingerprints and a mandatory native guard. Quarantine retains source/control evidence; remote issues are never deleted by this local rollback.

## Wrong vs Correct

Wrong: switch a global current-project variable before running retained provider work.

Correct: run the action inside `DaemonWorkspaceScope.run(originalGrant, action)` and revalidate the same grant after asynchronous authority checks.

Wrong: retry a timed-out remote create under a new ID.

Correct: keep its intent/command ID unknown, query original evidence and expose reconciliation without repeating the effect.

Wrong: treat a same-process decrypt/status exercise as proof that independent Electron roles share safeStorage keys, or remove native readiness while leaving the full renderer/IPC active.

Correct: use profile-scoped OS-wrapped protection across roles, validate with independent processes when authorized, and expose only the restricted bootstrap shell until protected authority is ready.
