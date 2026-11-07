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

Browser clients may send `X-Trellis-Session-Proof` with the current session's
CSRF value on authenticated requests. The service compares it to the authenticated
browser session and returns `X-Trellis-Session-Verified: 1` only on a match; a
mismatch returns `SESSION_CHANGED` (409) before the handler. Older clients may
omit the header. The current Web client requires the verification header for
scoped requests, so deploy the matching service before updating the Web client.

Independent local login needs no OIDC configuration. GET `/api/auth/options`
returns `{localLogin,selfRegistration,oidcLogin,oidcLabel,csrfToken}` and sets a
short-lived HttpOnly login-CSRF cookie. POST `/auth/local/register` accepts
`{username,password,displayName,returnTo?}`; POST `/auth/local/login` accepts
`{username,password,returnTo?}`. Both require exact Origin and the challenge in
`X-CSRF-Token`. Usernames are case-insensitive, 3–64 ASCII letters/digits/dots/
underscores/hyphens; passwords are 10–256 characters at registration. Registration
creates an ordinary person and session, never a platform administrator. Replies
are `{session:TeamSession,returnTo}`; person.provider identifies local/oidc/gitlab.
Clients that send `X-Trellis-Auth-Options-Capability: initial-task-types` receive
`supportsInitialTaskTypes: true` when the service supports atomic `createSpace`
initial task type selection. An absent flag means unsupported. Requests without
the header retain the legacy response shape for strict older clients.
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
  `{commandId,teamId,projectId,teamRoles,projectRoles,recipient,token,expiresInMs,spaceId?}`.
  The project must belong to the team. Recipient is either
  `{kind:'person',userId}`, `{kind:'local',username}`, or
  `{kind:'oidc-subject',subject}` under the configured issuer. A local username can
  be invited before registration, and an OIDC subject before its first login.
  Issuer namespaces remain separate even when the names match. `token` is `ti_` followed
  by the base64url encoding of 32 cryptographically random bytes. The Web client
  generates it once and pins it through command retry. Expiration defaults to
  one day, bounded from one minute to seven days. Only its SHA-256 hash is stored
  in invitations; receipts and event summaries contain no token. Response result
  is TeamInvitation metadata. If `spaceId` is supplied, the creator must also be
  authorized to manage that exact space. A repeated token under a new command is rejected.
- GET `/api/invitations?teamId=&cursor=&limit=`: browser team administrator list,
  including pending, accepted, expired and revoked records, without secrets.
- POST `/api/invitations/:invitationId/inspect`: authenticated recipient only,
  body `{token}`. Read-only inspection requires browser Origin/CSRF and does not
  accept the invitation.
- POST `/api/invitations/:invitationId/accept`: body
  `{commandId,token,expectedUserId,expectedTeamId,expectedProjectId,expectedSpaceId?}`. The browser
  explicitly confirms its current identity and fixed destination. One transaction
  consumes the invitation, grants team/project roles and records the command.
  If the invitation specifies a space, `expectedSpaceId` must match and the same
  transaction adds the recipient to that space. Existing roles are preserved.
  Current creator authority, recipient issuer,
  membership revisions, expiration and revocation are checked before admission.
  Retry uses the original command; another command cannot consume the link again.
  Workspace task or comment changes do not invalidate a space invitation. Space
  replacement, relevant access removal or an epoch change invalidate it. Old
  invitations without a space continue to grant only team/project membership.
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

`GET /api/projects/:projectId/crux/snapshot` returns
`{projectId,instanceId,epoch,authorizationRevision,revision,actor,canManage,snapshot,serverTime}`.
The project and device are reauthorized on each read. `afterRevision` and bounded
`waitMs` support long polling. The snapshot includes only currently readable space
content; a private-space metadata grant does not grant its bodies or member list.

`GET /api/projects/:projectId/crux/tasks/:taskId/development-context` accepts no
query fields and returns `{version:1,snapshot,inputs,codeResource,creations}` under
the normal `{ok:true,value}` envelope, with `Cache-Control: no-store`.
`shared/team-task-development.ts` exports `teamTaskDevelopmentContextSchema` and
its inferred `TeamTaskDevelopmentContext` type. The four fields reuse
`CruxRemoteSnapshot`, `TaskInputRead`, `TeamTaskCodeResourceDto` and `CreationList`.
One synchronous operation in the existing owned SQLite worker calls the original
getters with the same authenticated principal. Project, service instance/epoch,
authorization revision, task, space and task creation identity must agree. The
actor must be the current handler and a space member; unavailable tasks return
404 and other handlers return403. Each original getter retains its current ACL.
Creations are limited to the task's original space and task, with `scope:'team'`
and `limit:20`; `hasMore` is preserved and clients must reject incomplete input.
Closed tasks and input admission blockers remain facts for the client to assess.
This read does not execute, publish, approve, adopt or write a binding. It provides
no grant for a later action; each later read or write must reauthorize.

`POST /api/projects/:projectId/crux/commands` accepts
`{commandId,expectedEpoch,expectedRevision,operation,input}`. Supported operation
and input validators are `shared/crux-domain/commands.ts`; replies use
`cruxRemoteCommandReplySchema`. Epoch/revision conflicts return409 without applying
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

Historical `cruxCommand` receipts retain original instance/epoch/revision/time,
but their body and actor projection use current access. They prove the old
command, not the current workspace. Clients fetch a separate current snapshot;
they do not fill visible caches from historical receipts. Backup restore rotates
epoch and cursor secrets, preserving the original immutable backup and instance.

## Platform task executions — contract v2

Validators/types are exported from `shared/team-task-execution.ts` and this
package. Version 2 task identity contains `instanceId`, `projectId`, `spaceId`,
`taskId` and original `taskCreatedAt`; no local path/task directory is required.
It does not change the version 1 service or progress contract.

Base: `/api/projects/:projectId/crux/tasks/:taskId/executions`.

| Route | Input / value |
| --- | --- |
| GET base | Query `contractVersion=2&instanceId=...&spaceId=...&taskCreatedAt=...`; `TeamExecutionView`. |
| POST `/commands` | Full `TeamExecutionCommand`; committed/duplicate `TeamExecutionReceipt`. |
| POST `/reconcile` | The original full command; historical receipt or null, never a dispatch. |
| GET `/:executionId` | Same task query; retained `TeamExecutionRecord`. |

Commands include `contractVersion:2`, original UUID/task, `expectedEpoch`,
`expectedActorId`, nullable `expectedDeviceId`, `expectedGeneration` and nullable
`expectedExecutionId`. Kinds are `claim`, `report`, `finalize`, `release` and
`transition`; exact strict payloads come from `teamExecutionCommandSchema`.
Unsupported command versions reject with `UNSUPPORTED_EXECUTION_VERSION`.

Claim requires the current handler and one available effective writer; v1
progress binding and v2 execution exclude each other. Progress is bounded and
monotonic. Finalization resolves fixed approved document versions. Ordinary
handoff revalidates confirmed outputs and existing business roles, then revokes
the former writer atomically with task/progress changes. Native outcomes remain
`owner-reported`; authority revocation cannot establish process shutdown.

Historical receipt recovery requires current task read access, the original
reporter/actor/device, exact command scope/hash and epoch. A successful handoff
or later generation does not hide the committed receipt or restore old writes.
A null reconciliation result is not proof an in-flight request cannot commit.
Clients keep the same UUID/body and read the active projection separately.

The typed desktop bridge persists original task intents as profile-local SQLite
JSON before sending; credentials retain their existing protected secret owner.
Command bodies are not additionally encrypted. The bridge fences
connection/person/device/project changes and exposes read/history/command/
reconcile/pending operations through the existing protected worker. Command
preflight reads one original connection/UUID. Pending accepts
`{connectionId,task,cursor?,limit?}` and returns
`{contractVersion:2,connectionId,task,items,hasMore,nextCursor}`; committed history
is excluded before hydration. Pages default50/max100 and stay below 3 MiB minus
64 KiB, including a valid near-request-limit original command. The bridge starts
no engine and installs no project files. See the executable contract at
`.trellis/spec/backend/team-task-executions-v2.md`.

## Fixed execution inputs — contract v2

Schemas and canonical digest preimages are exported from
`shared/team-execution-input.ts` through this package. Workflow-template settings
accept optional `execution:PortableWorkflowDefinition` version 2. Existing
version-1 settings and input bundle hashes retain their original representation.
Portable definitions contain logical roles, ordered Agent/tool/gate declarations,
required capabilities and output/gate policies. Device-local engine, model,
profile, credentials and paths are resolved separately.

Base: `/api/projects/:projectId/crux/tasks/:taskId/executions/:executionId/inputs`.

| Route | Input / value |
| --- | --- |
| POST `/commands` | Strict capture command; committed/duplicate `ExecutionInputReceipt`. |
| POST `/reconcile` | Original full command; original receipt or null without dispatch. |
| GET base | Exact task query and `purpose=history|use`; fixed input, current bundle reference and availability. |
| GET `/resources/:selectionId` | Same query; original registered resource metadata, status and permitted fixed text. |

The query includes `contractVersion=2`, `instanceId`, `spaceId` and original
`taskCreatedAt`. Capture includes UUID `commandId`, `task:TeamTaskRef`,
`expectedEpoch`, `expectedActorId`, nullable `expectedDeviceId`,
`expectedExecutionId`, `expectedGeneration`, `kind:'capture'`, `roles` and
`selections`.

Each role binding names `roleId`, `agentId` and `expectedDigest`. The digest is
SHA-256 over `executionInputAgentDigestText` of exact Agent instructions and
resolved ordered skill contents. A selection has unique `id`, `phaseId`,
`nodeId`, `stage`, explicit `order`, `reason`, `required`, delivery policy and
fixed source. Source kinds are `governance`, `confirmed-document`,
`agent-instructions` and `skill`; caller paths or arbitrary text are unsupported.
Selection IDs allow at most 512 UTF-16 units, require well-formed Unicode and
reject exact `.` and `..` URL segments. Expanded input metadata must fit the
worker read-response limit minus
64 KiB before capture commits; oversized snapshots create no row or new body.

Capture requires the original active writer and matching adopted bundle and
portable definition. It creates one immutable input per execution using existing
blobs and transaction/receipt infrastructure. Each Agent node retains the
chosen Agent/skills, required adopted rules and template. New publications or
Agent/skill edits preserve existing captured bytes. Changing an original UUID
payload conflicts; retries/reconciliation preserve that UUID and original scope.

History reads check current resource/task authorization and return withdrawal
status with permitted original bytes. Execution use also checks the original
active owner/epoch/generation and required-version availability. Withdrawal can
block use while history remains readable; current ACL loss grants neither lane.
The original execution input and task's current adopted bundle are distinct.

The native source port reads these versions without local Trellis paths.
Pi/ACP composers retain per-node source order/reasons and exact digest/byte
receipts. They enforce the actual 8192-byte implicit resource envelope, including
JSON escaping. Full/partial/index-only/omitted/unavailable remain distinct;
missing or oversized required content rejects. Prepared composition does not
prove model receipt, compliance or execution. Exact native contracts and errors
are in `.trellis/spec/backend/team-execution-inputs.md`.

## Fixed execution artifacts and handoff

Version-2 execution commands add `save-artifact`, `seal-delivery` and
`checkpoint`. Their original task/person/device/epoch/execution/generation
envelope is retained; fresh producer operations also pin node and attempt.
The three new kinds require `expectedNodeId` and `expectedAttempt`. A bounded
optional per-node attempt ledger prevents reused producer identities on re-entry;
older rows receive no default fields. Historical original UUID recovery remains
available after producer movement under current ACL and original credential.
Schemas are in `shared/team-execution-artifacts.ts` and are exported by this
package. Relations use optional existing execution-record metadata and bodies
reuse immutable blobs; no separate approval store or database migration exists.

| Operation | Payload / result |
| --- | --- |
| `save-artifact` | UUID `artifactId`, nullable `previousVersionId`, supported artifact kind, title/text/digest, draft or confirmed disposition; immutable version receipt. |
| `seal-delivery` | Nullable exact previous version/digest and ordered `{outputId,ref,carriedFrom?}` entries; fixed manifest version/digest. |
| `checkpoint` | Exact manifest, remaining-work summary, selected code source and nullable device observation; fixed checkpoint version/digest. |
| GET `.../executions/:executionId/artifacts/:versionId` | Existing exact version-2 task query; current-ACL fixed artifact metadata and UTF-8 text. |

Artifact kinds are `implementation-report`, `check-report`, `general`,
`source-patch` and `selected-file`. Exact references resolve confirmed artifacts,
actual approved formal documents, or supported published same-space team HTML
creation revisions. Draft/conflict/unpublished/wrong-scope versions cannot
satisfy required outputs. `confirmed` describes server receipt, not QA or
document approval. Stale comparisons retain conflicts without replacing heads.

Manifest entries without `carriedFrom` are produced by the current node/attempt
and must satisfy its actual declared policies. Explicit carry refers to a sealed
node delivery or the original immediate predecessor's completed finalization.
Original producer refs may pass through later predecessors without copying
identity or bodies. Carried outputs cannot replace required fresh work.

Fresh managed completed finalization binds exact manifest/checkpoint refs and
the manifest's ordered outputs. Ordinary business paths revalidate original
refs and recipient access atomically before task transition and writer
revocation. Retained pre-upgrade completed formal-document finalizations keep
their original contract. Emergency reassignment/cancel and unknown native
facts retain existing semantics. Duplicate/reconcile uses the original UUID and
payload even after handoff, subject to original credential and current ACL.

Checkpoint source kinds are `none`, `selected-files`, `git-commit` and
`git-patch`. Native observations require an actual authenticated device and
remain `device-reported`; server-confirmed bytes do not attest to another
device's filesystem. Receiver ports verify actual code separately and distinguish
available-not-applied from applied. No workspace upload, checkout, push or merge
is performed. Exact native contracts/bounds are in
`.trellis/spec/backend/team-execution-artifacts.md`.

## Read-only Trellis source import

Contract version 1 uses validators/types from `shared/team-import.ts`, exported
by this package. Native discovery/capture reads the selected root locally;
HTTP commands receive only explicitly reviewed manifests and selected text.
Base: `/api/projects/:projectId/imports`.

| Route | Input / value |
| --- | --- |
| POST `/commands` | Full `ImportCommand`; committed/duplicate `ImportReceipt`. |
| POST `/reconcile` | Original full command; original command reply or null without dispatch. |
| GET `/namespaces` | Scoped `cursor`/`limit`; authorized namespace page. |
| GET `/items` | Required `namespaceId`, optional `importId`, `cursor`/`limit`; candidate page. |
| GET `/items/:candidateId` | Fixed candidate and digest/length-verified UTF-8 text. |
| GET `/batches/:importId` | Required `namespaceId`, optional `cursor`/`limit`; fixed manifest/digest and `receipts:TeamPage<ImportReceipt>`. |

Every command includes `contractVersion:1`, UUID `commandId`, `instanceId`,
`projectId`, `expectedEpoch`, `expectedActorId` and nullable `expectedDeviceId`.
Actions are `enroll`, `begin`, `map-task` and `snapshot`.

- `enroll` fixes `enrollmentKey`, `spaceId`, original `spaceCreatedAt` and `label`.
  Reuse that explicit namespace across members; paths, titles and Git remotes
  cannot establish source identity.
- `begin` fixes `namespaceId`, UUID `importId`, selected `manifest` and its
  SHA-256 `manifestDigest` over `canonicalImportJson(manifest)`. Source authors
  map explicitly to active space accounts or unresolved null.
- `map-task` selects `sourceTaskKey`, `expectedWorkspaceRevision`, nullable
  `aliasFrom` and `decision:{kind:'create'}` or
  `{kind:'link',task:TeamTaskRef}`. Preserve original mappings; changed locations
  require explicit alias review. New tasks enter triage through existing domain
  rules. Local completed/archive flags grant no business acceptance.
- `snapshot` sends `namespaceId`, `importId`, selected `itemKey` and exact `text`.
  The server verifies fixed UTF-8 digest/length, stages an immutable candidate
  through existing blobs and records a per-item receipt. Map task assets first.

Identical selected versions reuse candidates. Changed sources preserve the
original base and create compared candidates. Imported developer PRDs cannot
replace product PRDs or their approvals. Import changes no adopted input or
execution writer. Shared results remain `authority:'unactivated'`; candidates
remain `approved:false` and `writerGranted:false`.
Reordering otherwise identical author mappings does not create another version.
Each new snapshot receipt includes current `comparison` and `conflicts`, even
when its candidate is reused. The candidate's own comparison and original
command receipts remain historical. Reviewed task-directory aliases preserve
document identity instead of producing another version for the same bytes.
Task-mapping receipt `itemKey` is `task:` plus SHA-256 of the original UTF-8
`sourceTaskKey`; the full source identity remains in `mapping.sourceTaskKey`.
This keeps receipt cursor keys bounded for every admitted source identity.

Current account/device/project, space incarnation and task access apply to
commands, reads and replay. Original UUID/body retention and reconciliation use
the existing service mutation infrastructure. Recognized credentials, private
keys and private absolute paths reject with `IMPORT_PRIVATE_CONTENT`. Source
discovery, native bounds and exact error rules are documented in
`.trellis/spec/backend/team-trellis-import.md`.

## Current task progress

Validators and inferred types are exported from `shared/team-task-progress.ts`
and the service entry point: `teamTaskProgressStateSchema`, `SourceSchema`,
`BindingSchema`, `RecordSchema`, `DtoSchema`, `CommandSchema`, `CommandReplySchema`
and `ReceiptSchema` share the `teamTaskProgress` prefix. Resource IDs use
`teamTaskProgressResourceIdSchema`; project/person/device IDs remain UUIDs.

- GET `/api/projects/:projectId/crux/tasks/:taskId/progress` returns
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

## Shared task document drafts and fixed approvals

`src/shared/team-task-materials.ts` defines the executable contract and is exported
by the service package. Browser calls use the existing session, exact Origin and
CSRF token; paired devices use their project-bound bearer identity. Every request
rechecks account, team/project membership, task incarnation and current space ACL.

The base path is `/api/projects/:projectId/crux/tasks/:taskId/materials`.
Every GET requires `spaceId` and `taskCreatedAt` query parameters from the selected
task snapshot. Every command carries those fields in its body. A changed space or
creation timestamp causes `TASK_MATERIAL_SCOPE_CONFLICT`; an old document cannot
be retargeted to another task with the same title or reused task ID.

| Method and suffix | Result inside `{ok:true,value}` |
| --- | --- |
| GET base | `TeamTaskMaterialList`: identity, task scope and a metadata-only `page` |
| GET `/:documentId` | `TeamTaskMaterialView`: document metadata, selected version and one exact `text`; optional `versionId` selects a fixed version |
| GET `/:documentId/versions` | Service identity and a page of immutable version metadata |
| GET `/:documentId/submissions` | Service identity and a page of fixed submission/decision metadata |
| GET `/commands/:commandId` | The caller's currently authorized `TeamTaskMaterialReceipt`, or `null` if no matching committed command exists |
| POST `/commands` | `TeamTaskMaterialCommandReply`: `{status:'committed'|'duplicate',commandId,result}` |

Lists and both histories accept `limit` (1–100, default 50) and `cursor`. Continue
until `hasMore` is false, including after an empty filtered page. Cursors bind the
service epoch, caller/device, authorization and workspace revisions; document
lists also bind the material collection revisions, and histories bind their
document revision. `CURSOR_CONFLICT` requires reloading the first page. Ordering is
by opaque ID, not creation time; version `number` records its creation sequence
and can contain gaps after non-content commands. Lists never include bodies.

Every command requires an original UUID `commandId`, `expectedEpoch`, `spaceId`
and `taskCreatedAt`. Existing-document commands additionally require `documentId`.
Keep the same UUID and semantic payload after an uncertain acknowledgement.

| Action | Additional fields and effect |
| --- | --- |
| `create` | `kind`, `editorIds`, `approverIds`, `title`, `text`, `expectedDigest`, `references`; creates one server-generated document per kind and task incarnation |
| `saveDraft` | `expectedDraftRevision`, `title`, `text`, `expectedDigest`, `references`; advances the shared draft on CAS match, otherwise retains the candidate as an immutable conflict version |
| `setAccess` | `expectedRevision`, `editorIds`, `approverIds`; changes explicit editing and decision grants |
| `submit` | `expectedRevision`, `expectedDraftRevision`, `versionId`, `bodyDigest`; fixes the current draft for review |
| `approve` | `expectedRevision`, `submissionId`, `bodyDigest`; approves the pending fixed submission |
| `reject` | The same review fields plus a nonblank `reason`; records rejection without removing an earlier approval |

Kinds are `prd`, `design`, `implement` and `delivery-note`. Their built-in version-1
templates describe content sections; they are not configurable published workflow
templates or task transition gates. Task-space members can read documents subject
to all referenced source ACLs. Writes require current membership in an unarchived
space. Creation requires the space owner, task creator or current task handler
(assignee for tasks without a workflow). Those managers and the document owner can
change access. Editors and approvers must be explicitly selected active team and
project members in the task space. Project roles alone grant neither editing nor
approval. Each grant list contains 1–32 distinct people.

A stale draft CAS returns **committed**, with `result.outcome:'conflict-preserved'`
and `result.versionId` identifying the retained proposal. It does not replace the
current draft or change `draftRevision`. Read that version and the current draft,
compare them, then submit an explicit merge with a fresh UUID and current draft
revision. Retrying the original command returns its original receipt. A draft
revision ahead of the server is rejected. Document revision CAS failures return
`TASK_MATERIAL_REVISION_CONFLICT` without applying the command.

Only one submission can be pending. A version can be submitted once; after
rejection, save a revised draft before resubmitting. Approval always targets the
submitted version/digest, including when a newer draft exists. Later drafts never
replace `approved.versionId`. Fetch that exact version to read approved bytes.
Saving, submitting, approving and rejecting documents do not change the task's
business stage, execution progress or workspace revision.

Bodies are nonblank, well-formed Unicode, limited to one MiB of UTF-8. The server
verifies `expectedDigest` against the exact bytes, including BOM and line endings.
Stored blobs are verified again when read. Each document retains at most 1000
versions including conflicts; immutable blobs share the service's one-GiB quota.
The existing SQLite writer atomically commits metadata and command receipts;
schema v13 adds the document, version and submission tables to existing stores.

`references` contains at most 16 fixed references: `{kind:'material',materialId,
version,bodyDigest}` or `{kind:'creation',creationId,revisionId,bodyDigest}`. Sources
must belong to the same project; creations must identify a published revision.
Source content is not copied. Personal material ownership and creation-space ACLs
are checked on each access; a client `verified` assertion is not accepted.
Inaccessible documents/versions are filtered from lists. Document views and
histories require access to the references exposed by current document metadata
(draft, latest submission and approval), plus the selected historical version.
Thus an inaccessible current reference can make that whole document unavailable;
other readable documents remain independently listable.

`GET /api/commands/:commandId` also supports these receipts. Receipt reads check
the original actor/device and current task/source permissions. A receipt is a
historical acknowledgement, not permission to read content or advance a task.
An epoch change rejects the old POST, while an authorized receipt query can still
recover its historical result. Missing receipts do not prove cancellation.

Clients can use the existing Web `request()` transport with
`teamTaskMaterialListSchema`, `teamTaskMaterialViewSchema`,
`teamTaskMaterialHistorySchema`, `teamTaskMaterialSubmissionsSchema`,
`teamTaskMaterialReceiptSchema.nullable()` and
`teamTaskMaterialCommandReplySchema`. Native callers use the same authenticated
HTTP routes and validators. Material changes do not emit task progress or change
the workspace head; clients must explicitly refresh these material endpoints.

## Code resources and explicit task selection

`shared/team-code-resources.ts` exports `teamCodeResourceSchema`,
`teamCodeResourceCommandSchema`, `teamCodeResourceListSchema`,
`teamTaskCodeResourceDtoSchema`, `teamCodeResourceReceiptSchema` and
`teamCodeResourceCommandReplySchema`, with corresponding inferred types.

- GET `/api/projects/:projectId/code-resources?spaceId=&cursor=&limit=` returns
  `{instanceId,epoch,authorizationRevision,projectId,serverTime,canManage,items,nextCursor,hasMore,spaceResources}`.
  With `spaceId`, items are only that readable space's linked resources and
  `spaceResources` is `{spaceId,revision,resourceIds,defaultResourceId}`. Without
  it, administrators see the project catalog; other members see only resources
  linked to currently readable spaces. No response enumerates another space's links.
- POST `/api/projects/:projectId/code-resources/commands` accepts the strict
  commands below. It returns `{status:committed|duplicate,commandId,result}`;
  result is a compact historical receipt with project, epoch, kind, target ID,
  task creation identity when applicable, original `spaceId` (null for catalog
  commands), device ID, committed revision and time.
  Reconcile through GET `/api/commands/:commandId`, then reload current data.
- GET `/api/projects/:projectId/crux/tasks/:taskId/code-resource` returns the
  current task creation/update identities, `revision`, `canSelect`, `spaceRevision`,
  `selection`, `resource`, `defaultResource` and `availability`. Availability is
  `unconfigured`, `available`, `disabled` or `unlinked`. Existing tasks start with
  null selection/revision 0, even when their space has a default. The default is
  a candidate only; selection never follows a name or overwrites an existing choice.

All commands contain `commandId`, `expectedEpoch` and `expectedRevision`:

| kind | Additional fields | CAS target |
| --- | --- | --- |
| `create` | `resourceId`, `name`, `purpose`, `moduleDescription`, `source` | 0; caller supplies stable UUID |
| `update` | `resourceId`, `name`, `purpose`, `moduleDescription`, `disabled` | resource revision |
| `setSpaceResources` | `spaceId`, `resourceIds`, `defaultResourceId` (nullable) | space resource revision; full replacement |
| `selectTaskResource` | `taskId`, `resourceId` (nullable), `expectedTaskCreatedAt`, `expectedSpaceId`, `expectedTaskUpdatedAt`, `expectedSpaceRevision`, `expectedResourceRevision` (nullable only when clearing) | selection revision plus current task identity, space and resource fences |

`source` is `{provider,repositoryId,repositoryUrl}`. Provider is `git`, `github`,
`gitlab`, `azure-devops` or `other`; repositoryId is a provider identifier/path,
not a display-name match. URLs must use HTTP(S) or SSH without password, query,
fragment or credential username (`git` is allowed for SSH). Local/UNC/file paths
and unknown fields are rejected. Repository source is immutable; a different
repository requires a new resource ID and explicit relinking/selection. Metadata
records an administrator-approved source; actual repository credentials and remote
access are independently checked by the local development adapter.

An active project administrator, team owner/administrator with project membership,
or platform administrator with project membership configures resources. PM roles
alone cannot configure the catalog. Each private space still requires current
membership, including for administrators. Current handler, project PM/admin or
space owner may select a resource only while a current member of that active
space and the task is open and outside triage. Legacy tasks use their sole assignee;
workflow tasks use workflow.handlerId. Every request and receipt rechecks account,
device, team, project and current space/task authorization. Browser writes retain
Origin/CSRF checks; approved devices remain pinned to their project.

Resources can be linked independently to multiple spaces in one project. New links,
defaults and selections reject disabled resources. Existing selections retain their
identity when disabled/unlinked; unlinked selections return no resource metadata.
Changing defaults never changes task selections. Task deletion/movement or identity
replacement removes its selection atomically with the workspace write. Selection
requires the exact creation identity and space returned by the task-resource DTO;
replaying or reading a receipt also requires the task to retain its original space
and creation identity. Selecting or clearing a resource never changes task stage,
starts execution or clones code.
No machine path, secret or runtime transcript is stored.

Conflicts use `CODE_RESOURCE_REVISION_CONFLICT`, `CODE_RESOURCE_TASK_CONFLICT`,
`COMMAND_CONFLICT` or `WORKSPACE_EPOCH_CHANGED` (409). Inactive targets use
`CODE_RESOURCE_INACTIVE` (409); denied actions use `CODE_RESOURCE_FORBIDDEN` (403).
Missing/inaccessible references share `CODE_RESOURCE_UNAVAILABLE` (404).
Account/project/device failures retain existing authorization codes. Original
command IDs and identical bodies must survive unknown outcomes; duplicate receipts
never reapply changes, and a changed body conflicts. Browser/device identity cannot
be switched during retry. Old-epoch commands/receipts are rejected after restore.

The owned SQLite writer commits resource state and the existing command ledger in
one transaction. Schema v12 adds independent resource/link/selection tables without
rewriting old tasks. Project resources are limited to 1000, authorization spaces to
500, links per space to 64, and list pages to 100. Cursor scope includes workspace,
resource, link and authorization revisions; changes require a fresh first page.
Compact command receipts remain in the existing durable command ledger.

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

## Team content service

The executable contract is `src/shared/team-content.ts`. Schema v14 adds
`team_content_configs`, `team_content_jobs` and `team_content_commands` through
the existing owned writer. The service process makes one bounded HTTP request;
the SQLite worker only prepares, reserves, records dispatch and settles.

| Route | Authority and result |
| --- | --- |
| `GET /api/projects/:projectId/content/capabilities` | Current project member; model, enabled purposes, readiness, administrator responsibility and manual-work availability |
| `GET /api/teams/:teamId/content/config` | Current browser team owner/admin or platform admin; public configuration or null |
| `POST /api/teams/:teamId/content/config` | Same administrator; `TeamContentConfigure`, including UUID, epoch and expected configuration revision |
| `POST /api/teams/:teamId/content/probe` | Same administrator; UUID, epoch and expected configuration revision; creates a real budgeted text probe job |
| `GET /api/teams/:teamId/content/budget?userId=` | Same administrator; team and selected member UTC daily counts, measured token dimensions, unresolved reservations and unknown costs |
| `GET /api/teams/:teamId/content/jobs/:jobId/accounting` | Same administrator; job accounting metadata without member inputs, candidate or source references |
| `POST /api/teams/:teamId/content/jobs/:jobId/reconcile` | Same administrator; original UUID, epoch, expected job revision, external evidence, and measured usage or confirmed `not-started` |
| `POST /api/projects/:projectId/crux/tasks/:taskId/content/jobs` | Current project and actual space member; returns `{status:accepted|duplicate,job}` |
| `GET /api/projects/:projectId/crux/tasks/:taskId/content/jobs/:jobId` | Original person/device and current project/space/task authority; persisted job and candidate |
| `GET /api/projects/:projectId/crux/tasks/:taskId/content/commands/:commandId` | Same authority; recover the original job after acknowledgement loss |
| `POST /api/projects/:projectId/crux/tasks/:taskId/content/jobs/:jobId/cancel` | Same authority; UUID and epoch; cancellation does not establish absence of upstream consumption |

These routes use the existing authentication, exact browser Origin and CSRF
checks. A job pins service instance/epoch, person/device, project, space and task
creation identity. Reads, replays and dispatch recheck current authority; job
positions and role preferences never grant space membership. Removing access or
recreating/moving a task prevents reads/replays under its old identity. Restoring
access never retargets a job to another person, device or service epoch.
Administrators may reconcile frozen accounting from an earlier epoch under
current management authority; the original job epoch stays unchanged and cannot
be used for generation or candidate reads in the new epoch.

Administrators configure one `openai-compatible` text model per team, including
an exact HTTPS endpoint ending in `/chat/completions`, model, enabled purposes and
required limits. This slice supports non-streaming Chat Completions only. It
does not claim Anthropic, Responses, Ollama-native, tools, multimodal or arbitrary
provider support. Endpoints cannot contain URL credentials, query or fragment.
HTTP requires the exact origin in `TEAM_CONTENT_ALLOWED_HTTP_ORIGINS`. Requests
reject redirects, never retry, carry `max_tokens`, have a configured 100–60000 ms
timeout, and bound upstream JSON to 256 KiB and candidate UTF-8 text to 128 KiB.
Upstream error bodies, headers and credentials are never public diagnostics or
logs. Successful text is also scrubbed for a verbatim configured credential echo.

Before saving credentials, supply exactly one of
`TEAM_CONTENT_ENCRYPTION_KEY` (canonical base64 for 32 random bytes) or
`TEAM_CONTENT_ENCRYPTION_KEY_FILE` (absolute path to that base64 text). Provision
this key externally and retain it separately from database backups. The file
must be a regular protected file, at most 1024 bytes; POSIX permissions must deny
group/other access. On Windows the deployment operator must restrict its ACL to
the service account. Mount secret files read-only using a deployment Compose
override. No image key, automatic generated key or plaintext fallback exists.
Missing/wrong keys reject credential writes and dispatch, while readiness reports
the administrator action. Database credentials use AES-256-GCM with team-bound
authenticated context. Public DTOs contain only `hasCredential` and protection
availability, never ciphertext or keys. Omitting `apiKey` on a configuration
update preserves the existing encrypted credential and still checks protection.

Generation accepts `{commandId,expectedEpoch,expectedSpaceId,
expectedTaskCreatedAt,expectedTaskUpdatedAt,kind,text}`. `kind` is `requirements`,
`summary` or `test-package`; explicit text is at most 32 KiB UTF-8. The server
captures current task title/description and supplied text, keeping exact prompt
inputs privately and source IDs/digests/timestamps on the job. Template version
`team-content-v1` asks for facts, assumptions, acceptance and open questions, or
test steps/environment/data gaps. `evidenceCoverage` is
`task-and-explicit-text-only`; repository, deployed-capability and published-material
evidence are explicitly missing. No repository, private chat, material connector
or local execution is implicit. A model response is an unapproved candidate;
generation never publishes, adopts a material or changes task stage. A test-package
candidate does not execute tests or prepare data. Existing creation/prototype
generation remains a separate capability.

One UUID and identical normalized input recover one durable job. Changing its
payload or person/device/epoch conflicts. `pending` reserves capacity before
dispatch; `running` is committed before provider I/O. A completed candidate is
`succeeded`. HTTP errors, timeout, abort, malformed/oversize responses or lost
dispatch acknowledgements become `unknown` when consumption cannot be proven.
Pre-dispatch failures/cancellation release capacity. Running cancellation marks
uncertainty and aborts the actual in-process call. A provider result arriving
before reconciliation can still settle actual usage. A restart cancels pending
rows and marks running rows unknown; it never repeats a paid call. Expired
pending/running dispatches are reconciled every five seconds. A missing receipt
does not prove a concurrent prepare cannot commit.

Admission atomically checks per-team/per-member concurrent slots, UTC daily
request counts and declared input/output token reservations, plus a 32-slot
process bound. Team history is bounded to 20000 jobs. The per-job input allowance
uses a conservative UTF-8-byte-plus-framing estimate; it is not a measured vendor
tokenizer or an absolute upstream limit. Output uses the declared `max_tokens`.
Provider `prompt_tokens`, `completion_tokens` and optional cached-input tokens
are separate actual dimensions; cache is part of input and is not added twice.
Invalid/missing usage stays null. Missing price means `cost:null,costStatus:unknown`;
tokens are never treated as currency. A reported limit overrun remains visible.

Completed calls lacking usage retain token reservations, releasing only their
concurrency slot. Unknown in-flight calls retain both until an administrator
records an external accounting decision. Unresolved earlier-day reservations
also count against new daily admission. Request counts include admitted jobs and
are never silently reset by cancellation. Reconciliation records its actor,
evidence and time; supplied usage has source `administrator-reconciliation`,
distinct from provider measurement. It never calls the provider and fences late
settlement callbacks. These limits control new requests through this gateway;
they do not promise an absolute billing cap or govern external/private ACP use.

Readiness reports unconfigured, disabled, protection-unavailable, unverified,
ready or degraded, with bounded last probe/generation health and consecutive
failures. This is a backend readiness surface; a full alert claim/resolve workflow,
provider billing lookup, protected-file key rotation, UI onboarding and fixed
material/code evidence connectors remain outside this slice.

## Space governance and fixed task inputs

`GET /api/projects/:projectId/crux/spaces/:spaceId/governance` lists bounded,
body-free rule/workflow metadata. Cursor scope includes the space workspace and
catalog revisions. `GET .../governance/:packageId?versionId=...` reads exact
version bytes after current project/space authorization, including older and
withdrawn versions. Publication or a cached receipt never grants body access.

`POST .../governance/commands` accepts `create`, `saveDraft`, `setAccess`,
`submit`, `publish`, `disable` and `withdrawVersion`. Commands pin UUID,
`expectedEpoch`, `spaceId` and existing-package `expectedRevision`. The server
hashes full UTF-8 bodies; no renderer digest or approval flag is authoritative.
Create/access grants name active space people. An explicit package approver
publishes the exact submitted draft. Draft saves preserve the previous active
publication. Disabling prevents new adoption; saving another draft does not
reactivate it. Withdrawal requires a reason and invalidates adopted references
without rewriting their historical bundle. All versions and original command
identities remain retained. `GET .../governance/commands/:commandId` reconciles
only the original account/device under current space access.

Rules include modules, paths, formal stages, task types, required/recommended
obligation, numeric priority and optional `conflictKey`. Unknown future code
paths do not exclude a required rule. Workflow nodes use the existing formal
stages in their existing order, with configured material inputs, outputs and
approval roles; there is no separate workflow scheduler.

`GET /api/projects/:projectId/crux/tasks/:taskId/inputs` requires query
`spaceId` and `taskCreatedAt`. It returns the CAS head `revision`, immutable
`current` bundle or null, `admission` and optional formal `legacySummary`.
`admission.status` is `ready`, `requires-adoption`, `blocked` or
`review-required`. An existing PRD without approval blocks an empty baseline.
An approved required PRD/rule without explicit task adoption requires adoption.
Tasks with no mandatory shared input may use the current formal task summary.
Draft saves and new publications do not change existing task inputs.

`GET .../inputs/candidates` returns approved document references and published
rule/template candidates without bodies. Document references retain
`documentId/versionId/kind/spaceId/taskCreatedAt/title/bodyDigest/byteLength`.
`GET .../inputs/documents/:documentId/versions/:versionId` reads one exact
approved document with only that version's current upstream ACL and original
task scope. It returns the fixed reference and text, omitting mutable draft
metadata. An unrelated newer private draft cannot hide the adopted authorized
version. Native projection uses `CruxGovernanceService.readDocument` or
`GovernanceTransport.readDocument`; neither adds a renderer channel.
`POST .../inputs/commands` accepts `adopt` with document/rule/template version
IDs, the original UUID/epoch/task identity and `expectedRevision`. It resolves
actual approvals, exact bodies and ACL inside the SQLite transaction. All
applicable required rule packages and the required PRD must be selected;
same-priority required rules sharing a conflict key with different bodies block
adoption. Empty selection, missing body or invalid digest cannot pass. The
server stores a new immutable bundle with bundle ID, revision, SHA-256 digest,
fixed references and original actor/device receipt.

`withdrawDocument` is an explicit approver command against a fixed approved
document, with the input CAS head and a reason. It preserves the bundle and
requires review. `GET .../inputs/revisions/:revision` reads an earlier bundle
with fresh body/reference ACL checks. `GET .../inputs/commands/:commandId`
reconciles the original account/device. Receipt reads do not grant execution.
These commands do not advance the business workspace revision.

The server-only `TeamTaskInputs.validateTaskTransitionInputs(principal,
projectId,beforeTask,afterTask,transition)` hook runs inside the existing
workspace transaction after native domain validation and before persistence.
Forward transitions require a ready current baseline. Configured target inputs
and source outputs must be approved fixed documents explicitly adopted into the
bundle. Source output approvals must come from the configured active role;
explicit approval actions also require the actor's role. Product, developer and
tester grants come from current project membership or existing designated
delivery owners. Design authority uses explicit approvers of the adopted design
document because the current project role catalog has no separate designer
role. Space-owner gates require the actual current space owner. Recovery,
return, cancellation and reassignment actions retain their native domain rules.
The hook reads the immutable bundle and creates no second task state machine.

Desktop journals retain complete original commands before HTTP admission;
unknown writes reconcile/retry that exact command after restart. Browser session
storage retains references and hashes only; after reload a missing full payload
permits receipt reconciliation and prevents reconstruction from live editor
text. Account, project, device, service epoch and workspace changes cannot
retarget a retained operation.

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
