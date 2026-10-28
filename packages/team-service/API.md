# Team HTTP API — contract1

Runtime request/response validators are exported by the package and the shared
`src/shared/team-platform.ts`. API fields, not UI selection or local path names,
identify server resources. People, teams, projects, materials and devices use
server UUIDs. Local repository/workspace/task source references are separate
publisher metadata and never permission grants.

## Transport and authentication

The base URL is configured `TEAM_PUBLIC_ORIGIN`. Replies are
`{ok:true,value:T}` or `{ok:false,code,error}`. Durable writes return
`value:{status:committed|duplicate,commandId,result}`. Retain the same UUID
commandId and semantic payload after acknowledgement loss. Results are historical
receipts, not latest state. Different payloads under one command conflict.
Every read/mutation/replayed receipt rechecks current authorization.
An old team-creation receipt/replay requires current membership in that team;
leaving it does not prevent a separate authorized new-team command. A posted
mutation whose writer exits before acknowledgement returns
`ACKNOWLEDGEMENT_UNKNOWN`; retain and reconcile the same command identity.
Publication text and feedback body require well-formed Unicode; lone surrogates
are invalid input rather than silently normalized into replacement characters.

Optional external browser login is GET `/auth/login?returnTo=/...`, followed by configured OIDC
code+PKCE, expected state/nonce, signed ID-token/issuer validation and GET
`/auth/callback`. The opaque cookie `tp_team_session` is HttpOnly, SameSite=Lax
and Secure on HTTPS. GET `/api/session` returns TeamSession with the browser
CSRF token. Browser POSTs require exact `Origin` and `X-CSRF-Token`. POST
`/auth/logout` deletes the current session. A new completed login rotates and
invalidates the browser's previous local session. No demo-principal endpoint.

Independent local login needs no OIDC configuration. GET `/api/auth/options`
returns `{localLogin,selfRegistration,oidcLogin,oidcLabel,csrfToken}` and sets a
short-lived HttpOnly login-CSRF cookie. POST `/auth/local/register` accepts
`{username,password,displayName,returnTo?}`; POST `/auth/local/login` accepts
`{username,password,returnTo?}`. Both require exact Origin and the challenge in
`X-CSRF-Token`. Usernames are case-insensitive, 3–64 ASCII letters/digits/dots/
underscores/hyphens; passwords are 10–256 characters at registration. Registration
creates an ordinary person and session, never a platform administrator. Replies
are `{session:TeamSession,returnTo}`; person.provider identifies local/oidc/gitlab.
The existing session cookie, CSRF, account-disable and device ACL rules apply.
Local credentials use salted scrypt; password or session data is not stored in
browser command journals. Login failures for unknown, incorrect or disabled
accounts use the same `INVALID_CREDENTIALS` response. Registration/login have
separate IP rate limits, and password work has a bounded concurrency budget.
The returned same-origin returnTo preserves an invitation fragment; joining still
requires explicit authenticated acceptance after login or registration.

Active native devices use `Authorization: Bearer <deviceToken>`, without Origin
or a browser session cookie. Browser+bearer combinations are rejected. Devices
are restricted to their explicitly approved project and current account/member
rights. Pending credentials have zero project authority.

All lists return `{items,nextCursor,hasMore}`. limit defaults50/max100. Cursor
is opaque and binds store/epoch/account+device/scope/authorization; never reuse it
across a different owner or list. Invalid/stale list cursor returns409
`CURSOR_CONFLICT`. `/api/events` instead provides `resetRequired`. Empty filtered
pages can still have a next cursor. Continue until hasMore=false; do not infer
completion from a partial page. JSON item pages stop before512KiB without skipping
an excluded item. HTTP/RPC request envelope is2MiB; JSON reply bound is3MiB.

## People, teams and projects

- GET `/api/people?cursor=&limit=`: platform admin sees the registered directory;
  current team/project admins see people in their administered teams only.
- POST `/api/people/:userId/status`:
  `{commandId,active,expectedRevision}`; platform admin only. Disable deletes old
  sessions and revokes active device credentials. Re-enable requires fresh login
  and does not reactivate devices. Person response includes authorization revision.
- GET/POST `/api/teams`; create body `{commandId,name}`.
- GET `/api/teams/:teamId/members?cursor=&limit=`.
- POST `/api/teams/:teamId/members`:
  `{commandId,userId,roles,active,expectedRevision}`. Team roles owner/admin/member;
  initial expectedRevision=null, otherwise the observed revision. The last active
  owner cannot be removed before assigning another owner.
- GET/POST `/api/projects`; create body `{commandId,teamId,name}`.
- GET `/api/projects/:projectId/members?cursor=&limit=`.
- POST `/api/projects/:projectId/members`:
  `{commandId,userId,roles,active,expectedRevision}`. Project roles are an array of
  product/pm/developer/tester/admin, allowing combined responsibilities. Active
  team membership is required. Team/project member revocation also revokes affected
  active devices; later membership regrant does not revive old credentials.

Membership writes return their target teamId/projectId with userId, roles, active
and new revision. Direct membership assignment requires an existing person UUID.
Role sharing does not grant machine execution, credentials or private material access.

## Invitation links

Validators are exported from `src/shared/team-invitations.ts`.

- POST `/api/invitations`: browser team administrator only. Body:
  `{commandId,teamId,projectId,teamRoles,projectRoles,recipient,token,expiresInMs}`.
  The project must belong to the team. Recipient is either
  `{kind:'person',userId}`, `{kind:'local',username}`, or
  `{kind:'oidc-subject',subject}` under the configured issuer. A local username can
  be invited before registration, and an OIDC subject before its first login.
  Issuer namespaces remain separate even when the names match. `token` is `ti_` followed
  by the base64url encoding of 32 cryptographically random bytes. The Web client
  generates it once and pins it through command retry. Expiration defaults to
  one day, bounded from one minute to seven days. Only its SHA-256 hash is stored
  in invitations; receipts and event summaries contain no token. Response result
  is TeamInvitation metadata. A repeated token under a new command is rejected.
- GET `/api/invitations?teamId=&cursor=&limit=`: browser team administrator list,
  including pending, accepted, expired and revoked records, without secrets.
- POST `/api/invitations/:invitationId/inspect`: authenticated recipient only,
  body `{token}`. Read-only inspection requires browser Origin/CSRF and does not
  accept the invitation.
- POST `/api/invitations/:invitationId/accept`: body
  `{commandId,token,expectedUserId,expectedTeamId,expectedProjectId}`. The browser
  explicitly confirms its current identity and fixed destination. One transaction
  consumes the invitation, grants team/project roles and records the command.
  Existing roles are preserved. Current creator authority, recipient issuer,
  membership revisions, expiration and revocation are checked before admission.
  Retry uses the original command; another command cannot consume the link again.
- POST `/api/invitations/:invitationId/revoke`: body `{commandId}`; browser team
  administrator only. Accepted grants must instead be removed in member management.

Web links use `/?invitation=<uuid>#token=<secret>`. Login returnTo preserves the
fragment. The browser sends the invitation token in inspection/acceptance request
bodies; invitation navigation alone grants no membership. Disabling a recipient
or creator and changing relevant memberships permanently revoke pending invites.
Restoring membership does not restore those old links. Native devices cannot
create, list, inspect, accept or revoke invitations. No email or message is sent.

## Verified identity metadata

GET `/api/identity` returns the current authenticated person's verified issuer
and subject. `src/shared/team-identity.ts` exports its validators. A configured
GitLab native integration returns
`{provider:'gitlab',issuer,subject,baseUrl,clientId,scopes}`. `clientId` is the
separate public native OAuth application's identifier. A public OIDC client can
be reused when it has no secret; a confidential OIDC client is never advertised
as a native public client. Without that configuration, the reply is
`{provider:'oidc',issuer,subject,scopes}`. Local accounts return
`{provider:'local',issuer,subject,username,scopes:[]}`. No access token, refresh token, session
credential or client secret is returned. The native client obtains its own PKCE
grant and verifies the provider account against this subject.

## Material versions and recorded feedback

POST `/api/materials` validates publicationInputSchema:
`{commandId,materialId,projectId,visibility,title,kind,text,source,expectedVersion,
expectedDigest?}`. materialId is a stable caller-selected UUID. expectedVersion=null
creates; the currently observed positive version creates the next immutable body.
Visibility personal/project/team is explicit. Later versions never rewrite old
content, visibility, source or feedback. Only the material owner can publish a
new version. Personal body access stays owner-only even for administrators.

Server hashes actual UTF8 text and checks optional expectedDigest. Body bound is
oneMiB actual UTF8; JSON escaping/metadata must also fit the request envelope.
Source kinds: local-material (opaque repository/workspace/task alias plus selected
relativePath/version), authored(sourceId/version), external-reference(instanceId/
objectId/version, verified:false). Local/native identity aliases need a durable
private mapping; do not rewrite existing pinned run identities. Relative paths
reject absolute, parent, URI/drive and control syntax. No root/credential/chat
field is accepted. Verified body bytes do not prove native source execution,
Jira state, business review or QA. Text-only publication does not silently mirror
local images or entire repositories; attachment adapters are separate work.

- GET `/api/materials?projectId=&cursor=&limit=`: authorized latest versions.
- GET `/api/materials/:materialId/versions?cursor=&limit=`: authorized immutable
  metadata, newest version first.
- GET `/api/materials/:materialId/versions/:version`: TeamPublishedDocument, actual
  verified body/digest/length. No unauthenticated naked-hash blob endpoint.
- POST `/api/feedback`:
  `{commandId,feedbackId,materialId,version,body,quote?,anchor?:{start,end}}`.
  Quote/range must match the exact selected immutable version. Offsets are
  JavaScript UTF16 code units. This records feedback only, state=recorded and
  applied=false; it cannot assert boundary application or testing success.
- GET `/api/materials/:materialId/feedback?version=&cursor=&limit=`: paged feedback
  for the selected readable version.

## Desktop-first enrollment

POST `/api/device-pairings` is a rate-limited native setup request without cookie,
bearer or Origin: `{deviceName,projectId?:string|null,capabilityClaims}`. It returns
`{pairingId,deviceId,deviceToken,userCode,verificationUri,expiresAt,pollAfterMs}`.
Persist the pending candidate through the existing protected main credential store
BEFORE opening the browser. No project UUID needs to be copied before login.

The browser follows verificationUri, signs in, reads its real `/api/projects` and
selects a project. GET `/api/device-pairings/:pairingId` returns safe device details
and expiry, never the credential or verification code. If a pending enrollment
already requested a project, it cannot be retargeted.

POST `/api/device-pairings/:pairingId/approve` requires browser+CSRF and
`{commandId,userCode,expectedProjectId}`. Verify the desktop-displayed code. Approval
atomically binds one actual project/account and returns a historical receipt
`{deviceId,projectId,ownerId,decision:approved,approvedAt}`. A duplicate command
returns that same decision; it does not restore a later revoked credential.

The original candidate token becomes the active credential; no second secret
response can be lost. GET `/api/device-pairings/:pairingId/status` accepts only
that candidate bearer and returns actual pending/active/revoked/expired state.
Pending can have projectId:null/ownerId:null and online=false. Active always has
non-null project/account. Expired never-approved setup attempts can be cleaned;
unavailable pairing is not a grant or a cue to retarget an old queued operation.

- GET `/api/devices?cursor=&limit=`: own devices.
- POST `/api/devices/:deviceId/revoke`: `{commandId}`, browser owner only.
- POST `/api/devices/heartbeat`: active device bearer only,
  `{sequence,capabilityClaims}`. Monotonic sequence, actual server receipt time;
  repeated identical sequence cannot renew liveness. Claims are device-declared,
  never permissions. Online means a heartbeat within the default45s TTL, with
  nonnegative clock age; it is not proof of a live model or open socket.

There is no arbitrary shell/model/execute/repository upload endpoint. This is a
platform enrollment flow, not a claim of implementing OAuth Device Authorization.

## Shared task workspaces

`GET /api/projects/:projectId/hifox/snapshot` returns
`{projectId,instanceId,epoch,authorizationRevision,revision,actor,canManage,snapshot,serverTime}`.
The project and device are reauthorized on each read. `afterRevision` and bounded
`waitMs` support long polling. The snapshot includes only currently readable space
content; a private-space metadata grant does not grant its bodies or member list.

`POST /api/projects/:projectId/hifox/commands` accepts
`{commandId,expectedEpoch,expectedRevision,operation,input}`. Supported operation
and input validators are `shared/hifox-domain/commands.ts`; replies use
`hifoxRemoteCommandReplySchema`. Epoch/revision conflicts return409 without applying
the draft. Actor fields come from authenticated identity, never submitted names.

Local roster invitation/profile operations cannot change server identities.
Use the authenticated account/invitation/membership APIs. People may join public
spaces; private membership and archived-space mutations follow the space access
rules. Role and space action denials use `OPERATION_FORBIDDEN` or
`SPACE_ACCESS_DENIED` with403, while project/device access loss retains the
authorization error contract. Clients preserve an authorized reader after a
business action denial and retain its unsaved input.

Task, comment, version, Agent, squad and automation mutations share one serialized
workspace revision. Inbox recipients are explicit; read/snooze/clear preferences
are account-specific. The service runs due scheduled rules independently of open
desktop clients and persists their date deduplication in the owned transaction.
Runtime-bound configuration never becomes a claim of actual Agent execution.

Historical `hifoxCommand` receipts retain original instance/epoch/revision/time,
but their body and actor projection use current access. They prove the old
command, not the current workspace. Clients fetch a separate current snapshot;
they do not fill visible caches from historical receipts. Backup restore rotates
epoch and cursor secrets, preserving the original immutable backup and instance.

## Current task progress

Validators and inferred types are exported from `shared/team-task-progress.ts`
and the service entry point: `teamTaskProgressStateSchema`, `SourceSchema`,
`BindingSchema`, `RecordSchema`, `DtoSchema`, `CommandSchema`, `CommandReplySchema`
and `ReceiptSchema` share the `teamTaskProgress` prefix. Resource IDs use
`teamTaskProgressResourceIdSchema`; project/person/device IDs remain UUIDs.

- GET `/api/projects/:projectId/hifox/tasks/:taskId/progress` returns
  `{instanceId,epoch,authorizationRevision,projectId,taskId,spaceId,generation,binding,progress,serverTime}`.
- POST the same path followed by `/commands` returns
  `{status:committed|duplicate,commandId,result:TeamTaskProgressDto}`.
- GET the same path followed by `/commands/:commandId` returns a compact
  `TeamTaskProgressReceipt` or `null`, restricted to the original reporting actor.

Commands are strict objects:

```json
{"commandId":"UUID","expectedEpoch":"UUID","kind":"bind","expectedGeneration":0,"expectedBindingId":null,"source":{"kind":"web"}}
{"commandId":"UUID","expectedEpoch":"UUID","kind":"report","bindingId":"UUID","seq":1,"state":"running","step":"Implementing the selected change","blockingReason":null}
{"commandId":"UUID","expectedEpoch":"UUID","kind":"release","bindingId":"UUID","seq":2}
```

`bind` requires the observed generation and binding ID, including null for an
unbound task. Successful binding issues a new UUID and increments generation.
Replacing an existing binding requires an explicit takeover with both current
CAS values; clients must not silently refresh CAS and retry a takeover.
`binding` is null or `{bindingId,generation,reporterId,deviceId,source}`.
Device bindings use `{kind:desktop,sessionId,engine,directoryName}`; browser
bindings use `{kind:web}`. Session IDs are opaque platform aliases, engines are
short names, and directoryName is one safe display component. Absolute local
paths, credentials, engine transcripts, tools and token logs are not fields.

`progress` is null or `{seq,state,step,blockingReason,updatedAt}`. A new binding
starts idle at seq 0. States are `running`, `waiting_confirmation`, `paused`,
`interrupted`, and `idle`. Report/release sequences must strictly increase within
the original binding and authenticated session/device. Reports replace the whole
current record: required nullable step/blockingReason fields clear previous
values; summaries are single lines of at most 500 characters. Timestamps are
server receipt times, not device liveness or evidence that an Agent is running.
Release clears binding and progress and increments generation.

Each request rechecks account, team, project, device, current space visibility,
open task and active handler membership. Only the current handler may write;
archived spaces reject writes. Workflow tasks use workflow.handlerId; legacy
tasks require exactly one assignee. Handler, business stage, executor or workflow
handoff changes invalidate binding and clear progress atomically with the
business command. Removal also deletes the progress row, receipts and command identities. Task
closure makes reads and writes unavailable. Progress commands and heartbeat
receipt never advance workspace revision or create notifications. Formal stage
transitions continue through `transitionTask`.

`TASK_PROGRESS_UNAVAILABLE` (404) covers missing tasks and inaccessible spaces;
`TASK_PROGRESS_INACTIVE` (409) covers closed/triage tasks or invalid handlers.
`TASK_PROGRESS_FORBIDDEN` (403) covers writer/source/receipt ownership denials.
`TASK_PROGRESS_BINDING_CONFLICT`, `TASK_PROGRESS_SEQUENCE_CONFLICT`,
`COMMAND_CONFLICT` and `WORKSPACE_EPOCH_CHANGED` return409. Account/project/device
authorization errors retain their existing codes.

Keep the same command ID, actor, epoch, scope and body after unknown outcomes.
Command identities retain only UUID, request hash, one-way owner key and
task/project/account IDs as immutable, fixed-size idempotency metadata. They
remain until the task is removed; they contain no request body, progress text,
tool/token logs or transcripts. Metadata row count grows with accepted commands.
Complete receipts retain command kind, binding ID, generation, seq and commit
time, with only the latest 32 kept per task. Receipt eviction never deletes the
command identity. Reusing an accepted UUID with a changed payload conflicts,
even after its receipt has been evicted. The identical original request returns
duplicate with the currently authorized DTO and never reapplies old state or
recreates an evicted receipt. This DTO may have a newer binding or no binding.
Check an available original receipt before associating a returned binding with
an unknown bind; a missing receipt does not prove non-execution or authorize a
new binding. Generation/binding CAS and sequence high water marks also fence
new commands. The v11 migration preserves identities from all retained v10
receipts; identities already deleted by v10 cannot be reconstructed.
Restored epochs clear effective bindings and progress, reject old-epoch commands
and receipts, and require a fresh explicit binding.

Workspace long polls check an authenticated authorization/revision head on each
150 ms tick and construct the full scoped snapshot only when returning. Account,
device and project revocations remain visible while the request is waiting.

## Receipts and event catch-up

GET `/api/commands/:commandId` reads the caller's current-authorized committed
receipt `{commandId,kind,status:committed,recordedAt,result}`. Device reads are
restricted to their project and supported operation kind. Legacy receipts missing
scope metadata fail `LEGACY_COMMAND_SCOPE_UNKNOWN`; reconcile using the original
request rather than guessing a project. A missing receipt is a read-point fact,
not proof an in-flight request will never commit. Retry the same stable identity.

GET `/api/events?cursor=&projectId=&limit=` returns TeamEventPage:
`{contractVersion:1,items,cursor,resetRequired,hasMore,serverTime}`. Summaries are
currently ACL-filtered, body-free and scoped to authorized projects/owners.
A cursor contains store instance/epoch and actor/scope identity; reset requires a
fresh authorized snapshot/catch-up, not concatenation with another source. Event
sequence is the service log position, not a cross-system causal clock. Local
outbound queues and desktop recovery are integrated by the desktop owner.

## Creations and webpage review

The validated contract is `src/shared/creations.ts`. These routes use the existing
browser session/CSRF or approved desktop device identity and current project and
space authorization. They do not require a local code repository.

- `GET /api/projects/:projectId/creations?scope=personal|team&spaceId=&taskId=&cursor=&limit=` returns authorized metadata only. Ordinary lists omit confirmed-rule text; `taskId` selects frozen task references.
- `GET /api/projects/:projectId/creations/head` returns `{projectId,epoch,fingerprint}` from authorized identity/revision metadata. Poll this for changes; do not repeatedly download HTML.
- `GET /api/projects/:projectId/creations/:creationId?revisionId=&commentOffset=&commentLimit=` returns one selected body, revision metadata and a bounded comment page. Only authorized draft editors can select a draft or candidate. Private notes stay owner-only.
- `POST /api/projects/:projectId/creations/commands` accepts `CreationCommand`: original command UUID, creation UUID, expected revision, optional expected server epoch and one validated action. Responses contain body-free receipts. Reconciliation uses the original `/api/commands/:commandId` identity and rechecks access.

Actions create/edit drafts, publish fixed revisions, annotate/reply/confirm,
save/adopt/discard candidates and adopt a publication for an existing same-space
task. Publication and adoption do not change a task's business version, assignee
or lifecycle. A later publication cannot replace an adopted revision. Confirmation
records the displayed revision; unresolved required opinions survive later
publication. Adopted rule targets and interaction scenarios remain fixed.

Bodies are at most 256 KiB UTF-8. Lists, selected responses, histories and stored
records have separate bounds in the shared validators. HTML stays outside the
ordinary collaboration snapshot. Clients must host it only in the restricted
preview sandbox; never inject it into a privileged document.

Candidate generation uses the desktop's configured model and bounded exact source
replacements. The standalone browser does not claim to provide a model service.

## Runtime validators

Exported validators include teamSessionSchema, teamPersonSchema, teamTeamSchema,
teamMembershipSchema(project), teamTeamMembershipSchema, teamProjectSchema,
teamMaterialVersionSchema, teamPublishedDocumentSchema, teamDeviceSchema,
teamDeviceEnrollmentSchema, teamDeviceApprovalSchema, teamFeedbackSchema,
teamEventPageSchema, teamPageSchema(item), teamApiReplySchema(value) and
teamCommandReplySchema(result). parseTeamDevicePairing(raw) validates safe browser
pairing details. Use runtime validation on remote JSON; TypeScript casts alone are
not an authorization or provenance check.

Company identity, TLS/reverse-proxy settings and external SSO account lifecycle
integration are deployment gates. Existing local account/member/device revocation
is enforced on every API call; external SSO back-channel logout is not configured
or implied. Backup/restore and runtime setup are documented in README.md.
