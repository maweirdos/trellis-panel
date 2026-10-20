# Local Application Runtime

## 1. Scope / Trigger

Read this when modifying managed local applications, their UI/Agent entry points,
execution approval, environment loading, recovery or platform exit. The single
lifecycle owner is `src/main/services/app-runtime/`; old dev-run entry points are
adapters into that owner. Framework build scripts remain project-owned.

## 2. Signatures

Public validated configuration and DTOs live in `src/shared/app-runtime.ts`.
`ApplicationRuntimeApi` defines the renderer contract:

```typescript
appRuntimeList(expectedRoot: string): Promise<ApplicationListResult>
appRuntimeSave(expectedRoot: string, input: ApplicationSaveInput): Promise<ApplicationResult>
appRuntimeRemove(expectedRoot: string, id: string, revision: string): Promise<ApplicationSuccess>
appRuntimeImportNpm(expectedRoot: string, dir: string, script: string, name?: string): Promise<ApplicationResult>
appRuntimeStart(expectedRoot: string, id: string, revision?: string): Promise<ApplicationResult>
appRuntimeStop(expectedRoot: string, id: string): Promise<ApplicationResult>
appRuntimeRestart(expectedRoot: string, id: string, revision?: string): Promise<ApplicationResult>
appRuntimeLogs(expectedRoot: string, id: string, after?: number): Promise<ApplicationLogsResult>
onAppRuntimeEvent(listener: (event: ApplicationRuntimeEvent) => void): () => void
```

The main facade has the same domain operations with a canonical root first.
`start`/`restart` accept optional `{ expectedRevision, confirm }`; only a main UI
handler may provide the native human-confirm callback. `shutdown(): Promise<void>`
throws on unresolved cleanup. `hasOwnedApplications()` initializes persisted
project records before counting. `setAdmissionClosed(boolean)` controls new work.

CLI: `tpanel app list|status|start|stop|restart|logs [appId] --project <absoluteRoot>`.
See `docs/local-app-runtime.md` and `docs/access-protocol.md` for exact options and
TPAP wire responses. CLI mutations accept known IDs, not commands/env or approval.

## 3. Contracts

- Identity is canonical real project root plus stable application ID. Main derives
  its active root and compares the untrusted renderer `expectedRoot` before doing
  work. Capture the root before awaiting; never retarget delayed work after a switch.
- Register invokes under `ipcInvoke.appRuntime`; state/attention, output and done
  use the corresponding registered event constants. Events include root/app/run
  identities. Summary reads omit output; logs have a byte cursor and truncation flag.
- Definitions persist in isolated local userData (`app-runtimes` packaged,
  `app-runtimes-dev` development). Atomic versioned writes preserve errors rather
  than turning unreadable data into a saved empty configuration. Never put runtime
  authority or environment values into localStorage, broad Settings or shared files.
- Override patches are keep/replace/clear. Values are write-only and protected by
  system encryption. With encryption unavailable, reject persistent secret writes;
  ordinary env-file references still work. Public DTOs expose override names only.
- Precedence: inherited environment, ordered env files, explicit overrides. Read
  files on every start/restart and never mutate the parent environment. Windows
  keys compare case-insensitively. The UTF-8 single-line parser does not evaluate
  interpolation or shell substitution; limits and grammar are documented.
- Approval is tied to effective execution inputs, not a boolean sent by a client.
  Native review belongs to the main window and captured project generation. Recheck
  root, generation and launch fingerprint after review, including A -> B -> A.
  Environment-file values are mutable referenced inputs; changed references or
  explicit override settings invalidate approval. Approval is not a sandbox over
  every transitive dependency/source change under the same OS user.
- A project/app lifecycle queue serializes start, stop and restart. Duplicate start
  reuses the instance. Restart waits for verified tree exit and fresh port checks.
  Process state, service readiness and port ownership are independent observations.
- Readiness continues to observe the current run after its first success. A closed
  listener or failed HTTP response becomes unhealthy while a surviving child stays
  running. Each probe attempt has an absolute deadline, so slow trickling headers
  cannot extend its budget forever; old-run probe/observation results are discarded.
- Foreground child identity and observed descendants define ownership. Never grant
  termination authority to a stored PID alone. Unverifiable descendants or cleanup
  timeout remain unknown/cleanup-required; do not call them stopped or launch a
  replacement. External port occupants are diagnosed and never automatically killed.
- Output retention, event batches and individual chunks are bounded in bytes.
  Redact known supplied values before retention/broadcast, including chunk boundaries;
  arbitrary encoded or unknown child-output secrets remain outside that guarantee.
- Closing a conversation/view/window leaves main-owned apps running in the tray.
  `quit-gate.ts` confirms before closing admission and stopping apps, joins session
  cleanup/history drain, then tears down other subsystems. Cancellation changes no
  subsystem; failure reopens admission and preserves retryable cleanup information.
- TPAP keeps its existing loopback/auth/default-disabled requirements. Mutations
  require confirmation, request ID and concurrent replay handling; an exact payload
  mismatch cannot reuse another action's result. Native launch approval is separate
  from protocol `confirm: true`. Access events contain summaries, never log bodies.

## 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| No active UI project | `E_NO_PROJECT`, zero runtime mutation |
| Expected root differs / stale generation during review | Reject; no cross-project authorization |
| Invalid config/ID/revision/cursor | Structured `E_INVALID_ARG` or version conflict before spawn |
| First/changed Agent launch | `E_DENIED`, `APPROVAL_REQUIRED`, coalesced attention |
| Human cancels or execution inputs change during review | Zero replacement spawn |
| Malformed/missing env file | Non-secret filename/line diagnostic before spawn |
| Persistent override without encryption | Fail closed; no plaintext fallback |
| Port occupied externally | Conflict detail; external process remains alive |
| Child exists, no probe configured | Running process; readiness not configured |
| Probe timeout while child remains alive | Unhealthy readiness; do not invent process exit |
| Cleanup incomplete or identity unverifiable | Retain ownership/error; block restart and complete exit |
| Concurrent same request ID/payload | One operation; callers share its result |
| Same request ID with different action/project/app | `E_CONFLICT`, no second operation |
| Access disabled/unavailable | CLI setup-needed failure; do not enable it implicitly |

## 5. Good / Base / Bad Cases

Good: two agents start the same approved application, receive one run ID, and the
user stops that instance from the header without navigating away from a conversation.

Base: a project starts an explicit foreground Java build script with `.env`; restart
rereads credentials, and the script owns compilation of changed source.

Bad: a stale PID kills an unrelated process, a legacy npm path bypasses approval,
or successful `spawn`/`taskkill` is presented as service-ready/fully-stopped evidence.

## 6. Tests Required

- `app-runtime.mjs`: validation, persistence, env grammar/precedence/reload, exact
  approval, secret-safe outputs and bounds; no unrelated project mutations.
- `app-runtime-processes.mjs`: actual Windows foreground tree, external conflict,
  descendant termination, timeout and stale-identity behavior.
- `app-runtime-races.mjs`: remove/start/save registration races, stale observations,
  persistence failure retry and identity-less crash records that cannot falsely stop.
- `app-runtime-readiness.mjs`: absolute probe deadline under trickling HTTP headers
  and a real listener closing while its foreground process remains alive.
- `app-runtime-access.mjs`: real authenticated HTTP/CLI, packaged Electron runtime,
  no-approval bypass, explicit project and concurrent mutation replay/conflict.
- `app-runtime-ipc.mjs`: actual handlers, captured root, invalid inputs, main-only
  confirmation, cancelled and A -> B -> A stale reviews, event routing.
- `app-runtime-legacy.mjs`: real npm service, same common instance, approval,
  cross-project list/stop isolation and verified cleanup.
- `app-runtime-lifecycle.mjs`: real Electron quit event, cancellation, serialization,
  cleanup failure/retry, session-drain ordering and reentrant settled quit.
- `app-runtime-e2e.mjs`: built renderer/preload/actual handlers and real service;
  UI lifecycle/readiness, env reload and port release. Native human choice is
  simulated in this fixture and must be labelled as such.
- Existing TPAP/IPC registry regressions, typecheck, build and `check:ui`.

Fixture evidence does not measure IDEA/JVM memory or certify private project builds.

## 7. Wrong vs Correct

Wrong: `taskkill(pid); return { stopped: true }` using a PID from last session;
`start({ command, trusted: true })` exposed to an Agent; quit cancellation after
timers/access/agents were already torn down.

Correct: verify owned identity/tree and cleanup result, execute a stored exact
approved configuration through the single runtime, and ask before the quit gate
changes admission or any subsystem.
