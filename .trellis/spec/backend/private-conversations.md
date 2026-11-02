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

## File delivery

Import only explicitly selected regular files, with native size/count limits. Resolve paths physically, reject escaping paths and links, and recheck identity while reading. Lists and file reads are bounded. An unstable, missing or inaccessible file cannot become an advertised delivery.

Creating a material from a file reads the selected digest within the creation body limit. It opens the existing private creation draft editor. Publishing and task adoption use the established versioned creation commands and receipts; neither action publishes the source conversation.

## Requirement drafts and Trellis handoff

`shared/conversation-requirements.ts` owns the private draft, selected-file
revision, target and receipt contracts. Resolve the original conversation owner,
physical directory and calling document before writes and after async work.
Draft creation and task handoff retain their original command IDs; repeated
commands reconcile the same result rather than creating another object.

Keep private requirement metadata separate from native execution history. Actual
Markdown and explicitly selected immutable file snapshots live under the original
conversation directory. Compare both saved metadata and actual file digests;
neither editor save nor model-file sync may silently overwrite a different revision.
An existing requirement locks a draft's directory even before native execution.

Work requirements need no team membership or engineering selection while drafting.
Formal handoff requires a real Trellis directory selected through an owned native
grant, or the original Code directory explicitly confirmed for handoff. Validate
the Trellis layout and original physical identity. Create through
`createTaskRecordAt`, with `planning` status, PRD and immutable input provenance.
Private creator IDs identify provenance, not project assignees; leave assignment
unset until a project participant is explicitly chosen.
Do not start execution, approve implementation or publish a raw transcript.

Persist handoff intent before crossing the task-creation boundary. A partial or
uncertain response keeps the same target, command, draft revision and task identity.
Verify actual task metadata and each input file before reporting success. Do not
replace missing/changed tasks, overwrite modified task materials, or infer success
from a same-name directory. Opening the task verifies its original origin and uses
the existing project/task workbench; later stage execution keeps its own native
identity and lifecycle authority.

## Reference patterns

[Kun's workspace contract](https://github.com/KunAgent/Kun/blob/0d8406128e2cede3bb5085c2d28fb90ab9e91f69/kun/src/contracts/workspace.ts) keeps non-Git directories usable. [Multica's onboarding handler](https://github.com/multica-ai/multica/blob/5a2cc891ac338eed1919aa11a1eef5957cd82cec/server/internal/handler/mika_onboarding.go) verifies the member's session and delays execution until a real message. [Its draft store](https://github.com/multica-ai/multica/blob/5a2cc891ac338eed1919aa11a1eef5957cd82cec/packages/core/chat/store.ts) scopes drafts and failure recovery to their original context. These are interaction and ownership references; use this project's runtime and contracts.

[Kun's draft actions](https://github.com/KunAgent/Kun/blob/0d8406128e2cede3bb5085c2d28fb90ab9e91f69/src/renderer/src/sdd/sdd-draft-actions.ts) preserve dirty edits and synchronize actual saved Markdown.
[Its Code home candidates](https://github.com/KunAgent/Kun/blob/0d8406128e2cede3bb5085c2d28fb90ab9e91f69/src/renderer/src/components/chat/CodeHomeQuickStart.tsx) derive continuation shortcuts from real eligible records. Requirement execution and materials continue to use this project's Trellis contracts.
