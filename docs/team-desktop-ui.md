# Desktop team collaboration UI

The primary desktop entry is `TeamCollaborationEntry` in `renderer/src/team`.
The existing team page owns its mounting; the component does not replace local
members, reports or analytics. It uses the existing shared Modal, visual tokens
and InteractionScope. There is no additional global workflow route.

## Connection and identity

`api.teamDesktop` is the typed wrapped preload bridge. The renderer never handles
device credentials, cookies, fetch/proxy adapters or OS encryption. Pairing starts
with a service origin and device name; the main process protects and commits the
candidate before opening its browser confirmation page. Pending/project-null is
different from active, revoked, expired, disconnected and offline.

Verified person/project names and role arrays come from `connectionContext`.
An initially offline workspace retries that context on an observed network
transition without replacing the selected fixed reader. Requests are ordered so
a delayed older reply cannot replace newer context. Names and roles retained
while offline are labelled last-observed and do not prove current permission.
Heartbeat labels show actual recorded server times, not a local interval or
device-declared capability. Connection provenance retains the original origin
and identifiers. Local disconnect is explicitly distinct from remote revocation.

Locked/revoked/disconnected connections retain a local readonly outbox view.
Original operation IDs, receipts and unknown outcomes remain inspectable, while
shared bodies and remote retries are locked. A newly paired connection cannot
retarget old operations.

## Explicit publication

Authored publication defaults to personal visibility. The user explicitly chooses
a new material or a next version of an observed owned material. Expected version
is retained for server CAS; private/project/team visibility is per selected new
version and never silently overwrites old versions.

`PublishWorkflowVersionButton` captures its exact source when opened. Supported
shared source descriptors are task-run/ref, retained workspace-recovery run/ref,
and a registered fixed-document token. Passive parent graph/reader updates do not
retarget an already open publication. The renderer sends no old body, filesystem
path or scope grant; actual source membership/body/digest are resolved in main.

The form can save an offline intent under the original active, unlocked local
device/person/project binding even when fresh display names cannot be fetched.
It labels server authorization as pending recheck on reconnect. Actual cached
metadata may select a next-version target; it is not a current permission grant.
Explicit access denial disables saving. Pending or revoked connections never
qualify. Actual dispatch rechecks original server authorization and version.

Before requesting a queue write, publication/feedback captures and freezes one
payload and command UUID. Local browser storage retains only immutable operation
references/digests, never text or credentials. Each command has its own key, so
another window cannot overwrite a global reference array. Damaged/full storage
fails before dispatch and preserves original records. Lost acknowledgements keep
the same payload/identity; late old-project replies cannot clear that reference.
After reload without an in-memory payload, the UI inspects durable local records;
it never reconstructs and automatically reposts an absent body.

Standalone publication dialogs also subscribe to actual connection changes. A
revocation locks their form without changing a pending command or erasing its
reference; a late queue reply cannot revive the old form. Ordinary events keep
the original selected source and editable/frozen payload instead of remounting it.

Saving to the main-owned queue is distinct from remote publication. The root host
may automatically send never-dispatched queued work when the original connection
is usable. Unknown/dispatched work needs reconciliation; a missing receipt is
only a point-in-time observation. Explicit retry addresses the original command.
An access-revoked record can still have `outcomeUnknown=true` and remains unknown.

## Reading and feedback

The material list is bounded and paged, including empty filtered pages with a next
cursor. A real authorized metadata snapshot is seeded for restart discovery.
When offline, the UI reads the connection's actual cachedSnapshot; a bounded local
publication receipt page can offer incomplete document clues if no snapshot exists.
Reset-required and events-still-catching-up are separate labels. None claims a
complete currently authorized directory or guarantees a cached body exists.

Body reads validate runtime schema, UTF-8 length, SHA-256, actual material/version
and project/personal scope. Remote and cached-offline/last-observed are distinct.
Explicit access denial hides shared content and does not fall back to stale cache.
Passive updates/refreshes preserve selected A while B appears in the directory;
the user explicitly selects another fixed version. Invalid/late body replies do
not replace the existing verified body.

The dedicated sanitized Markdown renderer has no local repository asset context.
It does not execute raw HTML, fetch un-published images, or open a local link in
the currently selected repository. HTTPS/HTTP links use the existing explicit
main opener. Registered local native readers are separate from a future published
remote-native reader/asset adapter; no fake local path is created for remote text.

Feedback pins the exact material/version and optionally the exact raw quote.
Only a unique original-text match produces a UTF-16 range; repeated quote text
retains the quote without guessing an anchor. Rendered Markdown DOM offsets are
never treated as raw source offsets. Queued feedback is not yet recorded; recorded
feedback is not automatically applied, accepted as business agreement, QA-passed
or Jira-complete.

Switching to the outbox suspends feedback UI completions while retaining the
original draft/intent. Returning releases the obsolete busy state and permits an
explicit retry of the same frozen payload/command. Suspension never cancels an
already-admitted queue operation or treats an ignored reply as an unsent action.

## Verification boundary

`node scripts/smoke/team-desktop-ui.mjs` exercises actual production React,
InteractionScope, shared Modal, sanitized Markdown and Chromium. Its wrapped IPC,
backend and native interactions are explicit owned fixtures. It covers scoped
late replies, fixed versions, original unknown identities, offline reopening,
cached CAS targets, revocation, pending pairing, direct run/ref and registered
token publication, malformed data, paging, focus and responsive screenshots.

Full root TypeCheck/Build and the shared UI gate run separately. Actual service,
OIDC, protected worker restart, company SSO/TLS and connected desktop/Web acceptance
belong to their own reports and are not inferred from this renderer fixture.
