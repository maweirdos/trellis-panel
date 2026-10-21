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

Browser login is GET `/auth/login?returnTo=/...`, followed by configured OIDC
code+PKCE, expected state/nonce, signed ID-token/issuer validation and GET
`/auth/callback`. The opaque cookie `tp_team_session` is HttpOnly, SameSite=Lax
and Secure on HTTPS. GET `/api/session` returns TeamSession with the browser
CSRF token. Browser POSTs require exact `Origin` and `X-CSRF-Token`. POST
`/auth/logout` deletes the current session. A new completed login rotates and
invalidates the browser's previous local session. No demo-principal endpoint.

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
and new revision. A person must have signed in at least once before assignment;
use their own profile UUID for an explicit new-team invitation. Role sharing does
not grant machine execution, credentials or private material access.

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
