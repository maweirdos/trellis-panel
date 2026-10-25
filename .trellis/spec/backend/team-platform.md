# Team publication service and client boundaries

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
- Browser identity comes from the service's salted-scrypt local account login or
  optional OIDC authorization code, PKCE, state, nonce and validated issuer/signature.
  Local registration creates an ordinary person. The first visitor is never an admin.
  Browser writes use the existing HttpOnly session, exact Origin and CSRF token.
  Device bearer identity cannot be mixed with browser cookies/Origin.
- Server UUIDs identify people, projects, materials and devices. Local task,
  repository or workspace IDs are source metadata, never authorization. Preserve
  pinned local identities; map path-shaped native IDs to durable privacy-safe
  remote aliases rather than modifying the original run.
- Shared task/space/Agent commands follow [the collaboration contract](../shared/hifox-collaboration.md).
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

## 6. Tests Required

The isolated service runs its own `npm run typecheck`, `npm run build` and
`npm test`. Use actual HTTP/OIDC test-provider accounts, actual worker SQLite,
restart/migration/revocation, backup/restore and production-only installation
checks. Client work additionally exercises acknowledgement loss, restart,
account/project switching, stale cursors and protected credential failures.
Fixtures are labelled; company SSO and production deployment are not inferred.
The service has no configured lint script.
team-desktop-ipc exercises actual registry/preload plus strict source adaptation,
generation changes before/after enqueue and structured unknown errors, with
explicit domain fixtures. team-desktop-host exercises actual timers, queued-only
dispatch, admission pause/cancel and drain/cleanup retry against explicit service
fixtures. They do not replace the service's actual worker/HTTP/OS credential gates.
`team-collaboration-connected.mjs --fixed-reader` exercises production Electron
main/preload/renderer/native windows/default Windows protection, a signed owned
OIDC provider, actual service worker/HTTP and supplemental Web in isolated browser
partitions. Freeze each production build before starting; record its hashes and
explicit OS/test boundaries. Native-only outage, process restart/original command
IDs, retained A, current personal ACL and selected reader A publication while disk
B is current are distinct assertions. These synthetic accounts/one physical host
do not establish company SSO, separate-machine or installed-package acceptance.

## 7. Wrong vs Correct

Wrong: "The device was approved once, so an old token and cached role are enough."

Correct: every operation uses the pinned current service/project identity and
the server rechecks present authorization; the UI distinguishes recorded history
from current access and actual liveness.
