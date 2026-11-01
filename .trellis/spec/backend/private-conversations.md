# Private assistant conversations

## Identity and storage

`shared/private-conversations.ts` owns validated catalog and IPC contracts. The desktop conversation service owns creator identity, draft persistence, logical project association and the fixed native directory. Preload exposes conversation IDs and opaque native directory grants, never a generic runtime RPC or a caller-selected actor/root.

Personal Work requires no team account, space, logical project, role profile, Git or Trellis initialization. Its durable files live in an application-managed conversation directory. Code uses a directory explicitly selected through the native picker. Once a native identity is reserved, directory and runtime changes require a new conversation. Same-context classification changes metadata only.

The creator is derived from the original native profile and, for a team context, its verified business identity. Recheck membership, source and directory identity after asynchronous boundaries. Switching the selected engineering project cannot retarget a conversation or authorize an old permission request.

## Execution

Use the existing daemon-owned Pi/ACP runtime, four-connection admission, native process ownership, prompt receipts and permission lifecycle. Browsing history reads metadata and bounded events without connecting. First Send reserves one native alias; retries reconcile that alias and the original command identity. An uncertain dispatch is not permission to send again or create a replacement conversation.

Cancel, End and permission responses resolve the original session. A permission choice requires the exact pending request, advertised option and connection generation. Existing admission closure and cleanup lanes remain authoritative. Application-managed directories are permission scopes, not operating-system sandboxes.

Private file/image operations use their conversation-owned client. Do not attach the selected shell project, expose its knowledge tools implicitly, or write personal outputs through `.trellis/notes`. A raw transcript is never a team publication. Existing formal task progress continues to carry bounded lifecycle facts; task transitions and accepted material revisions retain their separate authority.

## File delivery

Import only explicitly selected regular files, with native size/count limits. Resolve paths physically, reject escaping paths and links, and recheck identity while reading. Lists and file reads are bounded. An unstable, missing or inaccessible file cannot become an advertised delivery.

Creating a material from a file reads the selected digest within the creation body limit. It opens the existing private creation draft editor. Publishing and task adoption use the established versioned creation commands and receipts; neither action publishes the source conversation.

## Reference patterns

[Kun's workspace contract](https://github.com/KunAgent/Kun/blob/0d8406128e2cede3bb5085c2d28fb90ab9e91f69/kun/src/contracts/workspace.ts) keeps non-Git directories usable. [Multica's onboarding handler](https://github.com/multica-ai/multica/blob/5a2cc891ac338eed1919aa11a1eef5957cd82cec/server/internal/handler/mika_onboarding.go) verifies the member's session and delays execution until a real message. [Its draft store](https://github.com/multica-ai/multica/blob/5a2cc891ac338eed1919aa11a1eef5957cd82cec/packages/core/chat/store.ts) scopes drafts and failure recovery to their original context. These are interaction and ownership references; use this project's runtime and contracts.
