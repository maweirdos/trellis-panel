# Private assistant conversations

## Identity and storage

`shared/private-conversations.ts` owns validated catalog and IPC contracts. The desktop conversation service owns creator identity, draft persistence, logical project association and the fixed native directory. Preload exposes conversation IDs and opaque native directory grants, never a generic runtime RPC or a caller-selected actor/root.

Personal Work requires no team account, space, logical project, role profile, Git or Trellis initialization. Its durable files live in an application-managed conversation directory. Code uses a directory explicitly selected through the native picker. Once a native identity is reserved, directory and runtime changes require a new conversation. Private theme classification changes metadata only.

The creator is derived from the original native profile. The conversation API has no team context, space selector or team project classification. Resource access and artifact/task delivery retain their own business authorization. Recheck the exact native owner and physical directory after asynchronous boundaries. Switching an account, team workspace or engineering project cannot retarget a conversation or authorize an old permission request.

Persist rename, pin and archive metadata in the private catalog. List active and
archived records explicitly, with pinned records first. Archive never stops the
native owner; sending requires an active record. Preview text comes from bounded
native conversation metadata, without hydrating each transcript while listing or
writing another catalog update for every streaming tick.

A saved requirement makes its original conversation discoverable even when no
message, imported file or native session exists. Consult the existing
`workspaceHasRequirements` owner before filtering an otherwise empty draft.
Listing must not start an engine or create a replacement conversation. Preserve
creator, archive, kind/project/search filters and the exclusion of task-owned
planning sessions.

Versioned storage conversion preserves existing personal history, drafts,
physical directories and native aliases. An old team-scoped record requires its
original creator proof before conversion; removing a scope field is not proof of
ownership. Preserve the original native creator identity when it differs from
the local catalog owner. Corrupt or unauthorized records cannot grant access to
another creator's session.

## Execution

Use the existing daemon-owned Pi/ACP runtime, four-connection admission, native process ownership, prompt receipts and permission lifecycle. Browsing history reads metadata and bounded events without connecting. First Send reserves one native alias; retries reconcile that alias and the original command identity. An uncertain dispatch is not permission to send again or create a replacement conversation.

Cancel, End and permission responses resolve the original session. A permission choice requires the exact pending request, advertised option and connection generation. Existing admission closure and cleanup lanes remain authoritative. Application-managed directories are permission scopes, not operating-system sandboxes.

Private file/image operations use their conversation-owned client. Do not attach the selected shell project, expose its knowledge tools implicitly, or write personal outputs through `.trellis/notes`. A raw transcript is never a team publication. Existing formal task progress continues to carry bounded lifecycle facts; task transitions and accepted material revisions retain their separate authority.

Ordinary ACP inventories, history, images, direct operations and event replay
exclude private aliases. The native private dispatch lane installs the exact
alias/creator/root proof through `withPrivateAcpOwner`; ordinary callers cannot
provide it. Keep the original cancellation fence through transport upload and
final dispatch. Cleanup checks the retained native owner even if its directory
was removed or replaced; new work and permission responses retain physical
directory checks. Directory grants share one bounded, expiring, document-owned
lifecycle and are removed on consumption or document release.

Configure and model recovery reuse the existing native controls with an exact
generation. Pi preview uses the existing bounded service with a session-aware
source resolver; it verifies the private creator before opening any file.
Preview roots are not supplied as authority by the renderer. Preserve the
native window/source checks, lease limits, revisions and sandbox policy.

## Submission and recovery controls

### Scope

Apply to pending private sends, explicit native reconnection, defaults for future
conversations, and build-compatibility recovery. Browsing history stays read-only.

### Signatures

- `ConversationApi.reconcileSend?(conversationId, requestId)` returns
  `{state:'sent'|'not-sent'|'unknown', turnId?}` inside `ConversationResult`.
- `ConversationApi.connect?(conversationId)` returns the original acknowledged
  `AcpSessionRecord`, without submitting a prompt.
- `setDefaultConversationModel?({modelId, expectedDefaultId?})` returns `{modelId}`;
  `onConversationDefaultsChanged?` invalidates window-local defaults.
- `DaemonApi.inspectRecovery?()` returns `{build:'current'|'changed'|'unknown',
  epoch}`. The existing `restart()` owns lifecycle mutation and interruption consent.

### Contracts

Local submission retains UUID, captured text, draft version and pending state
under the installation owner before releasing the unchanged composer. Image bytes
remain in owned memory, never text preferences. Local pending display is not a
persisted native user event. Replace it by exact request/turn proof, not matching
text. Newer edits survive acknowledgements and failed restoration attempts.

Reconciliation resolves only the persisted pending request of the authorized
conversation. An in-flight or uncertain request cannot become an automatic retry.
Explicit reconnect requires an existing private alias, fixed physical directory,
and current main-window source. Reject pending dispatch, running/cleaning work,
and unsupported resume; reuse an already-ready owner. Prepare restores the same
native alias and saved model without writing another user message.

Compare state revisions only within the same connection generation. Reads begun
before an acknowledged replacement cannot restore the old generation. Historical
event pages may remain readable without replacing newer live session metadata.

Default updates validate the current enabled catalog and expected previous
default after acquiring native settings revision. Patch only selector fields on
the current settings object; preserve credentials and unrelated provider edits.
Native CAS rejects concurrent writes. Existing conversations keep their models.

Known changed builds offer restart recovery; unknown compatibility offers
inspection, not a claim that an update exists. Reuse the exact-owner lifecycle,
then refresh source-owned history and explicitly reconnect without prompt replay.
Older bridges retain existing controls and require reopening the application to
load unsupported capabilities.

### Validation and errors

| Condition | Result |
| --- | --- |
| Lost send reply | retain original UUID/text; inspect original receipt |
| Confirmed not-sent result | retain the failed submission for explicit resend of the original payload without changing the draft |
| Connect while sending, running or cleaning | busy result; no prompt or replacement alias |
| Changed page, directory, creator or private source | reject; no late visible-state replacement |
| Lower revision in an acknowledged new generation | accept; old generation's counter cannot dominate |
| Stale read arrives after that acknowledgement | retain newer live metadata |
| Disabled model or stale expected default | reject without changing settings |
| Unknown build/owner | retain uncertainty and existing work; never infer idle or stop success |

### Cases

Good: local feedback is immediate, a lost reply is reconciled, and explicit
reconnection returns the original conversation to ready. Base: a removed saved
model still needs the existing explicit model-recovery flow. Bad: declaring a new
conversation's greeting to be proof that the original conversation recovered.

### Required verification

Delay persistence, native admission and acknowledgement independently. Exercise
event-before-response, reload, duplicate clicks, newer draft edits, unknown send,
explicit reconnect without prompt emission, and stale read after generation
replacement. Verify default persistence and concurrent credential edits in an
isolated native profile. Separate browser/port fixtures from real SDK and native
lifecycle observations; keep all test assets in OS TEMP.

### Wrong versus correct

Wrong: clear input only after the engine replies, compare revision counters
across generations, or reconnect implicitly when history is selected.

Correct: retain local recovery first, bind visible replacement to original
receipts, and reconnect only through an explicit original-source action.

## File delivery

Import only explicitly selected regular files, with native size/count limits. Resolve paths physically, reject escaping paths and links, and recheck identity while reading. Lists and file reads are bounded. An unstable, missing or inaccessible file cannot become an advertised delivery.

Creating a material from a file reads the selected digest within the creation body limit. It opens the existing private creation draft editor. Publishing and task adoption use the established versioned creation commands and receipts; neither action publishes the source conversation.

## Requirement drafts and Trellis handoff

`shared/conversation-requirements.ts` owns the draft, questions, fixed requirement,
separate plan, native operation, candidate, selected source, target and receipt
contracts. Resolve the original conversation owner,
physical directory and calling document before writes and after async work.
Draft creation and task handoff retain their original command IDs; repeated
commands reconcile the same result rather than creating another object.

Keep private requirement metadata separate from native execution history. Actual
Markdown and explicitly selected immutable file snapshots live under the original
conversation directory. Compare both saved metadata and actual file digests;
neither editor save nor model-file sync may silently overwrite a different revision.
An existing requirement locks a draft's directory even before native execution.
run captures the original command and native request before dispatching through
PrivateConversations.send. Observe reconciles that request and exact native turn;
idle state cannot prove completion. Adopt validates the real bounded candidate,
source snapshot, metadata CAS and disk digest. Unknown sends are never replayed.
Each integrated knowledge source retains the original connection/collection and
returned excerpt identity; that digest is not an upstream full-document revision.
Confirmation freezes a real snapshot, and later requirement changes invalidate
the dependent plan without removing its file or the previous evidence.

Work requirements need no team membership or engineering selection while drafting.
Formal handoff requires a real Trellis directory selected through an owned native
grant, or the original Code directory explicitly confirmed for handoff. Validate
the Trellis layout and original physical identity. Create through
`createTaskRecordAt`, with `planning` status, PRD, standalone plan and immutable
input provenance.
Private creator IDs identify provenance, not project assignees; leave assignment
unset until a project participant is explicitly chosen.
Handoff does not start execution, approve implementation or publish a transcript.
An explicit execution-preparation command validates the sealed handoff, uses the
official task.py start through existing native workcopy guards, verifies actual
status/context pointer and obtains an ordinary native origin. The private alias
and directory remain unchanged. Existing workflow preview/start owns phase
execution; preparation never dispatches a model prompt or a second executor.
Reconcile uncertain origin creation through its original daemon command receipt,
not another session. Reopening a prepared operation verifies immutable inputs and
the original session while allowing the workflow's legitimate working-file changes.

Main-only display text travels separately from the expanded native action prompt.
The public conversation Send DTO cannot provide it. New canonical user events
display the actual user request/action name while retaining the expanded prompt
in native diagnostics; saved earlier history is not rewritten.
For an ordinary send, derive display text from `draftText`. When the compiled
input has the exact file-list suffix, accept only paths registered in the same
owned row and show their `inputFileName` values. Keep the full paths in the
original expanded prompt. Ordinary display text has the same 200000-character
bound as Send; design/workbench action contracts retain their narrower bounds.
Text autosaves carrying unchanged runtime/model fields remain idempotent after
first native binding. Actual runtime, model and directory changes retain guards.

Persist handoff intent before crossing the task-creation boundary. A partial or
uncertain response keeps the same target, command, draft revision and task identity.
Verify actual task metadata and each input file before reporting success. Do not
replace missing/changed tasks, overwrite modified task materials, or infer success
from a same-name directory. Opening the task verifies its original origin and uses
the existing project/task workbench; later stage execution keeps its own native
identity and lifecycle authority.

## Independent editor polish

`requirements.polish.run/observe/cancel/apply` uses a caller-retained command UUID
as its operation ID. The native document owner, saved requirement revision,
document body hash, optional plan revision and exact selection witness fence all
operations. A command cannot be reused for different input.

Generation uses the existing application AI configuration and an independent
abort signal. Only selected text, up to 512 characters on either side and the
explicit edit instruction reach the model. It does not send a conversation turn,
create a visible chat, append `draft.operations`, save editor text or invalidate a
plan. Missing AI configuration fails this operation locally.

Native requirement metadata retains bounded technical input, candidate hash,
replacement, state and adoption receipt, separately from document revisions.
Admission allows at most four concurrent requests and 32 unresolved operations
per draft. Before new admission, cancelled, failed and adopted operations move to
immutable per-operation metadata files; write and verify each journal entry before
removing its inline row. Exact operation-ID lookup and adopted receipts remain
available after compaction and restart. Pending writes cannot be compacted. A running record without its original live request becomes unknown; it is
never automatically replayed. Cancellation discards late responses and cannot
cancel the main conversation. Application shutdown aborts remaining requests.

Apply verifies the original document, current file, base revision, selection
coordinates, surrounding witness and exact resulting body. It uses the existing
serialized CAS and pending-save recovery path. Repeated identical apply returns
the original receipt; a pending write must be reconciled before reporting adoption.
Only an adopted requirement change marks an existing plan stale.

Saved plan text may be polished independently even when its business plan is
stale. Verify the exact plan revision/body/file and retain its existing stale,
sourceRevision and sourceDigest fields. This does not relax planning or task
handoff checks. RequirementView.confirmationCurrent compares the saved requirement
body and source digest to its confirmation; a plan-only metadata revision does
not invalidate that confirmation.

## Reference patterns

[Kun's workspace contract](https://github.com/KunAgent/Kun/blob/0d8406128e2cede3bb5085c2d28fb90ab9e91f69/kun/src/contracts/workspace.ts) keeps non-Git directories usable. [Multica's onboarding handler](https://github.com/multica-ai/multica/blob/5a2cc891ac338eed1919aa11a1eef5957cd82cec/server/internal/handler/mika_onboarding.go) verifies the member's session and delays execution until a real message. [Its draft store](https://github.com/multica-ai/multica/blob/5a2cc891ac338eed1919aa11a1eef5957cd82cec/packages/core/chat/store.ts) scopes drafts and failure recovery to their original context. These are interaction and ownership references; use this project's runtime and contracts.

[Kun's draft actions](https://github.com/KunAgent/Kun/blob/0d8406128e2cede3bb5085c2d28fb90ab9e91f69/src/renderer/src/sdd/sdd-draft-actions.ts) preserve dirty edits and synchronize actual saved Markdown.
[Its Code home candidates](https://github.com/KunAgent/Kun/blob/0d8406128e2cede3bb5085c2d28fb90ab9e91f69/src/renderer/src/components/chat/CodeHomeQuickStart.tsx) derive continuation shortcuts from real eligible records. Requirement execution and materials continue to use this project's Trellis contracts.
