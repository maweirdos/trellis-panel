# Desktop team publication and synchronization

The main-owned `DesktopTeamService` lives in `src/main/services/team-platform`.
Its transport DTOs are in `src/shared/team-desktop.ts`. It contains no native
Agent execution or remote shell. The separate server contract remains
[team-service/API.md](../packages/team-service/API.md).

## Pairing and current identity

Configure an explicit HTTPS service origin. Only an explicit main-owned test
option permits loopback HTTP; credentials, path, query and fragment are rejected
in the origin. Authenticated redirects never forward credentials. The default
transport reuses the app's existing proxy configuration and bounded fetch path.

The desktop starts enrollment without requiring a project UUID. Before opening
the returned same-origin verification page, it encrypts and commits the original
candidate with existing Electron safeStorage protection. The protected tuple
binds token, service origin, connection, pairing and device. Editing an unprotected
origin or copying ciphertext into another binding cannot redirect that token.
Public DTOs and URLs never carry it.

The browser signs in through actual OIDC and approves the desktop code against a
real authorized project. Pending state permits setup polling only; it does not
grant heartbeat, publication or document access. Pending remains poll-eligible
after a pending status reply. Active state binds the original project/person once.
`connectionContext` reads current authorized person/project names and roles through
the actual session and bounded project pages; it does not invent display names
from opaque UUIDs or cache them as an authorization grant.

Heartbeat reserves a monotonic sequence before sending and records the actual
server acknowledgement. Device capabilities remain declarations. `remoteDevice`
is an observed server snapshot with actual lastSeenAt, not proof of a current
socket, model or native executor. Local disconnect locks that local connection;
remote device revocation remains a distinct browser/server operation.

## Durable commands and selected versions

The local userData `team-platform/team-desktop.sqlite` uses one owned worker,
DELETE/FULL transactions and a main-process PID/nonce lock. Another live main
cannot steal the store when a worker exits. Actual dead-main recovery serializes
lock replacement and preserves a stale evidence file. Unknown/corrupt/future
data is retained and rejected; the service does not reset over it.

Explicit publication pins command/material UUID, original connection/person/
project, visibility, expected version, exact text, UTF-8 digest and source before
dispatch. The main-only trusted-material adapter accepts an already authorized
immutable reader/store version. It never reads the newest disk body on retry.
Path-shaped local IDs map to durable private remote aliases without rewriting
workflow scope. Authored text is a separate explicit publication path. Attachments,
local Markdown image paths, raw conversations and repositories are not mirrored.

Feedback needs the exact locally cached selected remote version; optional quote
and UTF-16 range must match that body. New publication B does not replace selected
A or its feedback anchor. Recorded feedback remains applied=false, independently
of workflow feedback application, business agreement, Jira delivery and QA.

Outbox states distinguish queued, dispatching, acknowledgement-unknown, committed,
conflict, access-revoked and cancelled-before-dispatch. `outcomeUnknown` remains
independent: revocation cannot resolve a previously dispatched unknown effect.
Worker/main restart converts retained dispatching to acknowledgement-unknown,
never back to queued. A remote commit followed by local writer failure is also
reported acknowledgement-unknown.

`reconcile` reads the original command receipt. Missing is a read-point fact,
not proof an in-flight request can never commit. Explicit
`dispatch(commandId,{retryUnknown:true})` first verifies the same original current
server identity and reconciles an unknown command, then retries only its identical
payload/UUID. It can reverify an access-locked intent after that same connection
is actually usable again; it cannot revive a revoked server token or retarget a
new pairing. Background scheduling never sets this option. Only a never-dispatched
queued intent can be cancelled as unsent.

New command payloads are bounded to128MiB/2000 records; separately bounded receipt
and status capacity remains available for already-sent outcomes. Worker RPCs are
bounded to3MiB,64 pending and24MiB retained in-flight bytes. Timeouts keep their
budget until actual response/exit. The document body limit is1MiB UTF-8, the JSON
request envelope2MiB, and remote response3MiB. These are capacity bounds, not a
team-size or latency promise.

## Offline reads and synchronization

The selected immutable body validates remote schema, exact material/version,
UTF-8 digest/length and project/personal scope before caching. Pure network failure
may return that exact cached version only when allowOffline is explicit; it is
tagged cached-offline and last-observed. Authorization failure, including a
non-JSON HTTP401/403 proxy denial, locks shared cache presentation. It never turns
into a successful cached authorization. Already displayed renderer bodies must
also be locked/cleared by the host when that state changes.

Lists and local outbox pages are bounded and scoped. Empty filtered pages can
still have a continuation. Cursor reset requires a fresh authorized metadata
snapshot; the event catch-up point is established before the snapshot read so
changes during it remain catchable. Snapshot metadata does not replace the
selected document body. `eventsHasMore` persists backlog across restart separately
from resetRequired. Cached snapshots always say last-observed/stale.

The service has no automatic timers. The desktop host owns bounded setup polling,
heartbeat, event catch-up and queued-only dispatch. It first stops its scheduler
and closes admission at quit; the service drains serial and nonserial accepted
calls before closing its worker. Concurrent close calls share one drain promise.

## Verification and remaining gates

```powershell
node scripts/smoke/team-desktop.mjs --report .trellis/tasks/10-20-wf-team-web-foundation/research/desktop-integration.json
npm run typecheck
npm run build
```

The integration smoke uses the actual desktop service/worker, process exit,
SQLite, HTTP service and two real owned test-provider OIDC accounts. OS protection,
browser opening and declared transport failure/page-boundary seams are explicit
fixtures. They are not company SSO/deployment evidence. Root separately owns the
actual Electron safeStorage/native gate and IPC/renderer integration. This service
subset alone does not complete R2-01 or the source acceptance scenarios. There is
no configured lint script and no new production dependency in this slice.
