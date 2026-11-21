# Team publication service and client boundaries

## Local account passwords

`teamLocalPasswordSchema` in `src/shared/team-auth.ts` accepts 1–256 UTF-16
code units, preserves the input verbatim and accepts any character combination.
Desktop IPC and the HTTP service use this schema for registration and login.
Both registration forms must accept a single digit, letter or symbol.
Registering an existing username returns `409 REGISTRATION_UNAVAILABLE` and
preserves the account's original password.

## Read connection recovery

`TeamHttp` may retry a GET once when fetch rejects with `ECONNRESET`, directly
or in its cause, before receiving response headers. Yield to the event loop
before reconnecting and retain the original AbortSignal and total deadline.
The original URL, credentials and response validation remain unchanged.
Do not retry POST, cancellation, other network errors, received HTTP failures
or response-body failures through this path. A reset on a write remains an
unknown outcome requiring its original command receipt.

## Private requirement handoff

Task creation accepts an optional handoff ID with selected requirement version
label and body digest. Deduplicate by creator and handoff ID; a retry cannot
move an existing task to another space. Direct arrangement uses the existing
authenticated writable-space creation authority and validates selected assignees.
The handoff entry adds no separate role requirement.

Shared requirement creation binds the task's document ID, version ID and body
digest in the same material transaction as the create receipt. Later draft edits
retain that original fixed binding. Client reads explicitly request its version
and verify its body digest. A pending material command uses its original journal
record for reconciliation/retry. Unknown task replies and failed material writes
preserve the original creation identity and destination.

Private conversation IDs and creator mappings stay in local creator-scoped state.
Opening the source rechecks the private service's access and creator identity.
Team members receive only explicitly selected summaries and document bodies.

## 1. Scope / Trigger

Read before changing `packages/team-service`, supplemental Web clients, desktop
enrollment, shared publication or outbound synchronization. This service owns
team identities and published records. Local repositories, execution, private
memory and engine credentials retain their existing owners.

## 2. Signatures

The executable wire contract is `src/shared/team-platform.ts`; deployed routes
are documented in `packages/team-service/API.md`. Validate remote replies with
the exported Zod schemas, including `parseTeamDevicePairing` for its discriminant.
Desktop service/host/bridge contracts are `shared/team-desktop.ts`,
`shared/team-desktop-bridge.ts`, `services/team-platform/` and
`services/team-desktop.ts`. Its standalone built worker is team-desktop-worker.js.
The renderer calls `window.trellis.teamDesktop` and receives structured
`{ok,value}` / `{ok:false,code,error,outcomeUnknown}` replies, preserving uncertainty
across Electron error serialization. Native credentials/adapters are never options.

```text
GET /api/session
POST /api/device-pairings
GET /api/device-pairings/:pairingId/status
POST /api/device-pairings/:pairingId/approve
POST /api/materials
GET /api/materials/:materialId/versions/:version
POST /api/feedback
GET /api/commands/:commandId
GET /api/events
```

## 3. Contracts

- Keep the independently deployed Node service and its production dependencies
  outside Electron's dependency tree. The current adapter is single-instance
  SQLite with one owned worker and verified immutable blobs, not an assumed
  company database or distributed writer. Configure the actual public origin,
  issuer, client and exact bootstrap subject explicitly.
- A personal browser session can submit `{commandId,name}` to `POST /api/organizations`.
  One writer transaction creates the organization, its owner membership, its initial
  project and admin membership, a public `MAIN` space with the creator as a member,
  and the command receipt. The result identifies `{teamId,projectId,spaceId,name}`.
  Validate `teamId` and `projectId` as UUIDs and `spaceId` as a Crux resource ID.
  Resume navigation and desktop pairing against the returned project. The separate
  `POST /api/teams` operation creates an organization without provisioning a project.
- Browser identity comes from the service's salted-scrypt local account login or
  optional OIDC authorization code, PKCE, state, nonce and validated issuer/signature.
  Local registration creates an ordinary person. The first visitor is never an admin.
  Browser writes use the existing HttpOnly session, exact Origin and CSRF token.
  Device bearer identity cannot be mixed with browser cookies/Origin.
- Browser requests with `X-Trellis-Session-Proof` must match the authenticated
  session's CSRF value before the handler runs. Only a matched request receives
  `X-Trellis-Session-Verified: 1`. Web scoped requests require that response and
  fence late replies by their original session. Older clients may omit the proof;
  deploy the matching service before the new Web client. Do not log the proof.
- Server UUIDs identify people, projects, materials and devices. Local task,
  repository or workspace IDs are source metadata, never authorization. Preserve
  pinned local identities; map path-shaped native IDs to durable privacy-safe
  remote aliases rather than modifying the original run.
- Shared task/space/Agent commands follow [the collaboration contract](../shared/crux-collaboration.md).
  Their server epoch/revision, current space ACL and per-person inbox projection
  remain distinct from document publication versions and feedback records.
- Pending enrollment may have no project. Save the returned candidate credential
  through the main protected credential store before opening the verification
  page. Pending credentials have no publication, project-read or heartbeat grant.
  The browser chooses an actually authorized project and approves the exact code;
  pre-targeted projects cannot be changed. Active credentials bind once to that
  person/project. Never send credentials through renderer state, URLs or logs.
- Recheck account, team, project and device authorization on every request and
  before replaying an old receipt. Role arrays support combined responsibilities.
  Personal material bodies stay owner-only, including against administrators.
  Revocation survives later membership restoration; old tokens do not reactivate.
- Publication explicitly selects an immutable text version and visibility. Verify
  actual UTF-8 digest/length on the server and client. The one-MiB body, two-MiB
  request envelope and three-MiB response envelope have different bounds. No
  implicit repository, chat, image, attachment or private-memory mirroring.
- Feedback refers to the selected material/version and matching quote/range;
  offsets use UTF-16. Recorded feedback remains `applied:false`. Saving,
  publishing, delivery, feedback application, business agreement, QA and Jira
  completion are separate events.
- Keep one command UUID and identical semantic payload through acknowledgement
  loss/retry. A committed receipt is historical, not a latest-state grant. A
  missing receipt at one read point is not proof an in-flight write cannot commit.
  A desktop outbox must pin service identity, person/device/project and exact
  body before dispatch; changing an account or project must not retarget it.
- The Electron host resumes only an existing team store on startup. It owns
  bounded background polling/heartbeat/event catch-up and queued-only dispatch;
  unknown/dispatched rows never receive automatic retryUnknown. Local scheduling
  timestamps throttle work, not establish liveness. Follow local queue pages so
  terminal history cannot indefinitely hide later pending rows. Retry connectivity
  with bounded backoff. A reset loads actual authorized metadata, not a forged
  complete cache. Passive change events carry IDs/reason/time, not body/token data;
  ordinary read replies must not recursively invalidate their own subscriptions.
- Main-only workflow publication resolves exact run/ref membership (or exact
  retained recovery run), then passes original stored text/digest/source/owner to
  the publication service. Strip UI source discriminants before strict domain
  calls. Reject renderer text/scope/path overrides and stale expected project
  roots/generations. A project change after enqueue reports possible admission,
  not rollback. Unsupported remote/source adapters remain explicitly unsupported.
- A `fixed-document` publication resolves the original registered `rd-` token
  through `DocumentViewService.selectedMaterial`, without constructing a workflow
  application or rereading the current file. Preserve the original material owner
  and complete bytes, including BOM; presentation-only normalization is not the
  publication body. Compare real filesystem root identities for Windows aliases
  while retaining original namespace tokens and the before/after generation fence.
  Native readers query sender-bound `documentWindowSourceState()`; its boolean
  result grants neither path access nor arbitrary source registration.
- Quit pauses new team admission/background work, drains original admitted calls
  and then closes its worker. A failed close remains fenced but permits a
  deliberate cleanup retry; do not retain a permanently rejected wrapper promise
  that prevents joining the original service. No remote success or rollback is
  inferred from local process cleanup.
- Lists and event catch-up are bounded and cursor scoped. Continue while
  `hasMore`; an empty filtered page is not necessarily the end. On conflict/reset
  load an authorized snapshot, then start a new cursor. Do not concatenate epochs
  or present a stale cache as currently authorized shared content.
- Actual authenticated heartbeat receipt advances liveness. A replayed sequence,
  browser page, device-declared capability or cached timer does not prove online
  execution capability. The service has no arbitrary native shell/model endpoint.
- Backup/restore uses the owned writer and verifies database/blobs/identities;
  do not add arbitrary HTTP destination paths. A live/ambiguous store owner lock
  is not stolen when its worker exits. Company SSO lifecycle/TLS/reverse-proxy
  deployment remains a separate real-environment gate.
- Normalize legacy `hifox_*` workspace, inbox preference and task progress
  table names inside a writer transaction before numbered migrations. Use the
  stored table names to detect the upgrade because `PRAGMA user_version` can
  already have advanced. Preserve rows and foreign keys, keep one set of
  membership revision triggers and reject conflicting names for the same table.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| New login with issuer unavailable | Visible login failure; no demo principal |
| Existing valid session, developer offline | Authorized published versions remain readable |
| Pending pairing without project | Setup status only; no heartbeat or publication |
| Pairing approved for another project | Reject; never retarget a credential |
| Member/device revoked after a prior command | Recheck current rights before replay/read |
| Same command ID with changed body | Conflict; no replacement or second intent |
| Stale list/event cursor | Explicit conflict/reset and authorized reload |
| Unknown POST outcome | Retain exact outbox identity and reconcile |
| Structured command `TASK_INPUT_TEMPLATE_ROLE_REQUIRED` HTTP 403 | Reject the business operation; exempt device locking only after fresh original credential, device, account, project, instance, epoch and command-space proof |
| Unknown, malformed or non-JSON command 403; device 401 | Keep authorization fence and POST uncertainty; remote error prose is not authority |
| Persisted Crux double lock | Explicit original-command retry verifies original authority, atomically restores its connection, then queries its receipt; that invocation sends no business POST |
| Late proof after disconnect, revocation or credential/binding change | Original full-record CAS fails; retain lock, command and uncertainty |
| Repeated identical lock while already locked | Increment internal `accessGeneration`; an older proof cannot clear the newer fence |
| Original sourced CAS conflict plus complete terminal proof | Preserve the old command as `conflict` with `outcomeUnknown=false`; permit existing explicit discard, never auto-create a replacement |
| Personal body requested by admin | Deny unless that person owns the body |
| Local Markdown image path in published text | Do not advertise it as a remotely published asset |

## 5. Good / Base / Bad Cases

Good: a developer explicitly publishes PRD version A; an authorized product person
reads A while that machine is offline and records feedback anchored to A. Later
publication B preserves A and its original feedback.

Base: a clear local task executes without a team account or a live server.

Bad: automatically upload the latest working file after reconnect, treat a saved
feedback comment as applied, reuse a queue under a different team, or mark an
approved-but-unseen device online.

## 6. Validation

Run `npm run typecheck` and `npm run build` in each affected team package; run root `npm run check:acpx` and `npm run check:ui` for desktop changes. Temporary validation scripts, accounts and stores belong in OS TEMP under the root local-only rule.

Use isolated HTTP/OIDC accounts and actual worker SQLite to verify scope, restart/migration/revocation, backup/restore and lost-ACK command identity. Exercise protected credential failures, current personal ACL, account/project changes, stale cursors, queued-only dispatch, admission pause/cancel and drain/cleanup retry through real registry/preload/host boundaries.

Verify schema renames against a populated historical store and an empty store.
Assert that startup and restart both reach `/ready`, the historical account
retains its ID, and workspace revisions, inbox preferences and progress
receipts survive. Verify foreign keys and a single revision increment when
membership changes. Exercise conflicting table names and verify rollback.

Crux command-lock recovery uses the main-only
`cruxRevalidate(connectionId, pin, command, assertCurrent)` service method. The
pin fixes the original origin, pairing, device, owner, project, service instance,
epoch and minimum authorization/workspace revisions. Read pairing status,
device session, project membership and a fresh snapshot with the original
protected token. Require active device/person, exact identity, non-regressing
heads, current task/space access and the caller's unchanged selection. Apply
the verified device through `update-connection.expectedConnection`, comparing
the complete captured connection inside the store transaction before mutation.
No preload unlock flag or replacement identity is accepted.

The internal connection JSON contains `accessGeneration: number`, a safe
nonnegative integer defaulting to zero for old records. Every `lock:true`,
disconnect, revoked-device or expired-device update advances it even if every
other field remains identical. It is independent of remote heartbeat `sequence`
and omitted from `publicConnection()`. Pairing-status and heartbeat replies also
compare the captured connection before applying active-device state. At numeric
saturation, invalidation still persists and active-device recovery is permanently
rejected; overflow cannot roll back an access fence.

A terminal original-command conflict requires all of the following:

- `TeamHttp.request()` received a bounded, schema-valid HTTP 409
  `REVISION_CONFLICT` for this exact original command POST route and body. The
  error's native WeakSet provenance alone is only a candidate.
- The actual service `TeamStoreCore.mutation()` authenticates the original
  owner and checks `(userId, commandId, kind, requestHash)` before calling
  `TeamCruxWorkspace.applyBusinessCommand()`'s revision CAS. Its single writer
  commits the effect and receipt in the same transaction. This ordering means a
  sourced old-CAS rejection had no committed original effect at that point.
- Fresh native verification proves the original credential/device/person/project
  and command space, exact instance and epoch, and a durable workspace revision
  strictly greater than the original expected revision. Same-epoch revisions
  only advance; `restoreTeamBackup()` rotates the epoch. A delayed copy of that
  unchanged original command therefore cannot commit later.
- `cruxCommand()` receives the coordinator's captured authority head as its
  fourth main-only argument. Proof revisions must also be at least that observed
  workspace and authorization head. A missing head cannot certify a terminal
  conflict; neither a regressed proof nor a matching instance alone is sufficient.
- Query the original receipt again. A matching receipt settles the original
  effect; it never becomes a no-effect rejection. For the missing-receipt case,
  require unchanged binding, encrypted credential and `accessGeneration` after
  the final query before branding the terminal conflict.

Only that verified terminal brand can retire an earlier `outcomeUnknown=true`.
For a dispatch with no earlier uncertainty, a freshly verified structured
business denial retains the original command as `queued`, with
`outcomeUnknown=false`. The transport's conservative POST flag must not turn
that rejection into an unknown outcome. The existing explicit discard can
then release it so the user can choose an authorized action. This exemption
requires the native verified-denial brand, not an error-code allowlist.
An isolated receipt 404, arbitrary 403, unsourced/bare revision conflict,
non-advancing or changed-epoch head, failed proof or newer invalidation retains
uncertainty and keeps discard disabled. Explicit discard then ends the proved
old intent; a later explicit business action captures a new UUID and current
CAS without rewriting the old command.

Verify actual role denial without either persistent lock; legacy double-lock
reload with receipt GET and zero business POST; committed unknown ACK without
resend; same UUID/body POST only on a later explicit retry; unchanged CAS
success and legitimate role-grant CAS conflict. Verify late disconnect/revoke/
credential change, stale instance/epoch/authorization, removed membership,
invalid credentials, malformed proof and network failure cannot unlock. Retain
the pending command's original UUID, payload, guards, attempts, uncertainty and
diagnostic cause when a subsequent local guard reports `ACCESS_LOCKED`. Missing
receipt at one read point does not establish that no earlier effect occurred.

Exercise the complete path through the existing pending JSX/event handler,
account adapter, IPC and coordinator: old unknown lock → proof-only retry →
authorized role grant → sourced old-CAS rejection and terminal proof → visible
explicit discard → one new current-version approval effect. Verify committed
lost-ACK settlement instead of discard, old JSON without `accessGeneration`,
repeated same-code/same-value locks, proof-time re-locks, failed terminal proof
and saturation. Keep prior failing evidence separate from repaired evidence.

Connected acceptance must verify retained reader A while disk B is current, explicit publication of the selected version, outage/restart and original command recovery. Freeze the production build used for native checks and record its identity. Synthetic accounts on one host do not establish company SSO, separate-machine or installed-package acceptance.

## 7. Wrong vs Correct

Wrong: "The device was approved once, so an old token and cached role are enough."

Correct: every operation uses the pinned current service/project identity and
the server rechecks present authorization; the UI distinguishes recorded history
from current access and actual liveness.

Wrong: classify every 403 as device revocation, unlock from a matching error
string, grant `developer` locally, or rewrite a stale command's expected revision.

Correct: a bounded structured denial is only a candidate; native proof validates
the original authority before a business-denial exemption. Explicit recovery
restores receipt lookup, preserves the exact pending command, and leaves later
business authorization and CAS to the server.
