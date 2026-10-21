# Project Knowledge and Native Agent Contracts

Ordinary language in the existing Agent conversation is the primary document,
publication and handoff interface. The native Agent synthesizes the relevant
discussion and invokes scoped tools to write the document and perform requested
next steps. Never require copying a reply into an editor or clicking a separate
form Save. Management editors remain secondary, not a simulated intelligent flow.

## 1. Scope / Trigger

Read before changing WeKnora integration, project knowledge scope, source evidence,
product-material handoff, manual knowledge publication, or the native MCP bridge.
Knowledge is a shared capability; do not introduce a second Agent engine or a
role-specific authorization product to implement it.

Saved artifact preview assets and explicit current-file opening follow
[knowledge-document-reading.md](knowledge-document-reading.md). Neither reading
nor opening establishes publication/review/write authorization.

## 2. Signatures

- Shared DTO/API: `src/shared/knowledge-access.ts`, `KnowledgeApi`,
  `KnowledgeScope`, `KnowledgeSource`, `KnowledgeArtifact`, `KnowledgePublication`.
- Preload: `api.knowledgeAccess`; channels: `ipcInvoke.knowledgeAccess.*`,
  registered in `src/main/ipc/knowledge-access.ts`.
- Main: `knowledgeAccess.capture(owner)`, `search(owner,scope,input,signal)`,
  `read(owner,scope,input,signal)`, `markSupplied(owner,sourceIds)`.
- Host actions: `context`, `collections`, `updateScope`, `documents`, `source`,
  `sources`, `importLegacy`, `saveArtifact`, `artifacts`, `artifact`, `taskPrd`,
  `handoff`, `previewPublication`, `confirmPublication`, `publications`,
  `publicationPage`, `resolvePublication`, `clearHistory`.
- Native: `knowledgeMcpBridge.connect(identity,observe)`, connection `servers`,
  `admit`, `endTurn`, `disconnect`, `revoke`; the public acpx `mcpServers` resolver
  supplies descriptors on connection creation/load/resume.
- Native workflow DTOs: `src/shared/knowledge-conversation.ts`; service
  `knowledgeAccess.conversation(owner,scope,input,signal)`. Inputs are `context`,
  `read_document`, `read_task`, `save_document`, `publish_document`, `handoff`.
  The model supplies generated content and known identities, never root,
  credentials, session, arbitrary destination paths or execution status.

## 3. Contracts

### Connection, Scope and Identity

Integrations stores protected WeKnora credentials and one enabled knowledge
binding per project, with `knowledge.defaultCollectionIds`. Multiple collections
are allowed; a missing/disabled/empty binding never means all libraries or global
fallback. Import old settings explicitly and bind only the selected project when
requested. Interactive Knowledge, legacy planning and gateway reads must use the
same service. Keep opt-in legacy spec synchronization separate; archive automatic
deposition remains disabled.

The host captures root, project generation, session and turn; native callers do
not supply these through tool arguments. Freeze scope for a turn and validate
binding/connection revisions before result delivery. Overrides are currently
temporary in-memory conversation scope, reset on app restart. They are not an
upstream ACL. Local knowledge can work while remote knowledge is unconfigured.

### Evidence and Materials

Source handles are opaque and owner/scope-bound. Snapshot exact supplied bytes,
their SHA-256, source identity, timestamp, mode/truncation and original turn.
Retrieved is not supplied; supplied is not proof the model relied on the text.
For native tool reads, mark supplied only after the actual MCP response has been
written and its owner has not been cancelled. For host-prefetched references,
use the real native prompt-write boundary described below. Neither proves model
reliance. Do not correlate ACP toolCallId with MCP request IDs.

Host `source`/`sources` calls with a `sessionId` enforce that session. Calls that
intentionally omit it are project-wide historical browsing and must be labeled as
such; they are not native Agent evidence or a private-session ACL.

Private validated state is under
`userData/knowledge/<real-project-root-hash>/state.json` (schema1). Limits include
20 MiB state, 1500 sources, 500 artifact versions and 500 publication records.
Hard limits fail visibly; never silently discard pinned evidence or unresolved
receipts. Corrupt/future/checksum-invalid data stays intact and fails closed.

Product Markdown uses `.trellis/notes/<kind>-<id>.md` and is repository material,
not private personal storage. Artifact version is the exact body hash; same-body
metadata changes cannot overwrite an immutable record. Use revision-aware atomic
writes and realpath fences, not old unconditional note/PRD writers. Do not
automatically copy all corporate source text into shared Markdown.

Handoff reuses an explicitly selected or conversation-bound active task after
reading its current PRD and supplying its expected revision. When requested,
`createTask=true` uses the supported task creator with a deterministic host slug
and `planning` status. It adds the product path/hash backlink, never starts coding,
approves implementation or mirrors Jira status. Preserve user/external edits.
Conversational materials have `confirmed=false` and an `agent-conversation`
origin with connection generation, user-request hash and `review=not_asserted`.
Saving is not formal business review; manual confirmation is not Agent authorship.

`conversation-actions.json` is a separate private version1 ledger (500 actions,
2 MiB), not an optional field older state writers could drop. Persist pending
before mutation and retain exact results for replay/crash recovery. Action IDs
hash root/session/turn and normalized input; each admitted turn has a fresh UUID.
Connection generation is separately checked through the trusted owner and kept
in the receipt. Activity rendering additionally includes generation in its
identity. Receipts record provenance, not independent semantic proof of consent.

### Host-First Project Evidence

For evidence questions with selected project libraries, the host retrieves before
native prompt dispatch. Reuse the same admitted owner, frozen scope, knowledge
service and native session. No second chatbot, mandatory role or four-level
retrieval orchestrator. Native
spec/business, code, history and Skills remain native follow-up capabilities.
Image-only input and unbound projects retain their existing contracts.
`skipConversationActionLookup(text)` is a narrow anchored action guard, not a
semantic classifier: clear consolidation/rewrite of preceding discussion does
not search those command words or append a reference packet. A no-search guard
accepts only a standalone prohibition or a fully recognized transformation tail,
not arbitrary comma suffixes, quoted examples or inquiries. Keep knowledge-turn
admission/action tools even when preflight is skipped. Mixed/actual evidence
questions are not skipped by document/action noun matching; unmatched requests
retain the existing policy, not a claim of complete intent understanding.
An API-assisted semantic router is proposed separately and must not be silently
enabled from global AI settings or advertised as delivered by these exclusions.
An actual Agent-advertised slash command is not an ordinary question: preserve
its native command path without automatic knowledge/task-material text. Unknown
slash names are not invented commands. Capture failure must explicitly report
that no project lookup or evidence delivery occurred; it is not an empty result.

`KnowledgeMcpConnection.preflight(text,signal)` prepares bounded reference content
and returns `text`, `assertActive`, `delivered` and `notSent` checkpoints. The query
uses at most2000 characters and discloses a prefix cut without splitting a
surrogate pair. Initial limit3 applies to each existing provider, not a fictitious
global ranking. Select at most4 whole original excerpts under a32 KiB UTF-8
serialized envelope budget, including metadata/escaping. Report omissions and
source truncation distinctly. Never clip text while claiming the larger saved
snapshot was supplied. This is not a token count or complete-document guarantee.
Within this preflight budget, selected-project WeKnora excerpts get priority
over local supplemental hits, preserving order within each kind. Otherwise local
matches could exhaust the budget and hide the very bound library requested by
the user. Keep the search service's other callers/order unchanged; include total
and per-kind omission counts. Retrieval order is still not business authority.

The host lookup has a10-second wait bound and links to current-turn cancellation.
Late, revoked or changed-scope results cannot enter the prompt. Empty, partial,
unavailable and degraded persistence remain distinct; an unavailable result is
not a successful empty search. Same-turn exact query/scope/effective-limit reuse
is bounded to admitted-turn memory. Keep source IDs/hashes and do not duplicate
upstream searches or snapshots for that same cached request. Refined queries and
different coverage may search again. Do not claim semantic deduplication of
independently configured global/native MCP servers.

Append an explicitly untrusted host-reference envelope separately from original
user text and task references. Original user/action provenance stays intact.
Mark only actually included durable source IDs supplied after public
`turn.promptStarted` resolves (the real transport writer accepted the prompt),
with owner/scope still current. Register that checkpoint before terminal cleanup
can invalidate an instant response. Search completion or merely calling
`startTurn` is not delivery. Write rejection/cancellation before that checkpoint
must retain unsupplied state and a truthful not-sent outcome.

Host lookup events are host operation facts, not fabricated native tool calls or
proof that a native MCP client discovered/called a tool. Preserve those separate
discovery/transport facts. Native HTTP support does not decide whether a host can
deliver plain-text reference content through an otherwise supported ACP prompt.
Never change user native configuration, grant native approvals or install Skills
as a side effect of preparing project evidence.

### Native Tool Transport

Use exact pinned `@modelcontextprotocol/sdk` protocol transport; the JSON control
API is not an MCP server. Bind only loopback with strict Host/path, no browser
Origin, bounded body/concurrency, and per-connection opaque bearer grants.
Read tools are `knowledge_search` (query <=2000 characters), `knowledge_read`,
`knowledge_context`, `knowledge_document_read` and `knowledge_task_read`.
Action tools are `knowledge_document_save`, `knowledge_document_publish` and
`knowledge_document_handoff`. Mutations require a trusted admitted native user
turn captured before reference/task prompt assembly. The Agent uses its actual
conversation context to synthesize the body; do not replace this with a regex
intent router or last-answer copy. Existing native tool approval policy remains.
Never put the upstream API key in descriptors, prompts, repo files or history.

Discovery before a turn is allowed; knowledge reads require an admitted active
owner. Each authenticated MCP request ID has bounded grant-local cancellation;
the SDK sends `notifications/cancelled` as another POST. Duplicate active IDs
must fail and another grant cannot cancel the original request. Cancellation,
revocation and late results cannot mark evidence supplied.

Descriptor attachment is not discovery. Observe actual tools/list/calls. Explicit
negotiated HTTP=false makes this HTTP bridge unavailable; absent capability is
unknown. Preserve user text/image-only wire contracts. Shared workflow semantics
belong in MCP server instructions and the public new-session system-prompt append,
not an alteration of submitted user text. Do not assume every adapter honors
that metadata; verify actual model behavior separately. In the inspected pinned
Codex ACP2.2.2 path, generic `_meta.systemPrompt` is not consumed; accepting the
public session option is not proof that the model received those instructions.
Do not impersonate a vendor-specific namespace or replace native base instructions
to conceal that gap. Keep original native
permission IDs/kinds. Redact
display labels; fail closed instead of remapping machine IDs containing grants.
Active grants remain redacted even when bounded retired-grant history rotates.

Teach project/company lookup to use this host's scoped search/read, not an
independently installed global WeKnora server. Missing project binding must not
silently widen the scope. This is model guidance: the public ACP/acpx API does
not portably disable all inherited global MCP servers. Host ACLs constrain these
host tools only; never claim external native plugins are project-isolated.

Operation activity carries `payload.knowledgeOperation` and
`activityScope='turn'` with exact root/session/generation/turn. Emit running from
the real call, update the same operation from committed facts, and reject late
old-turn results. Do not equate intent text, tool discovery or attached
descriptors with actual lookup/save/publication. MCP request bodies are bounded
at 1 MiB; generated document bodies remain bounded at 200k characters, without
silent truncation.

Search/read operations optionally carry actual `status: KnowledgeStatus` and
`persistence: 'durable'|'degraded'`. Preserve the actual query on terminal facts.
Partial, empty, denied, unavailable and degraded outcomes must stay readable;
older events lacking these fields keep their existing fallback presentation.
Host preflight and native-call activity may share source rendering, never their
proof of native discovery or invocation.

### Explicit Publication

Preview exact title/body, artifact revision, effective per-use scope, session and
selected target. Persist the pending UUID/payload before one POST; changes to the
scope, binding/connection revision, session or target invalidate the preview. A successful
create requires usable remote identity; indexing remains unknown until observed.
Missing ID, lost response, cancellation after send or crash is uncertain, not a
safe automatic retry. Joined callers must each retain current owner authority.

The conversation tool performs preview/confirmation internally only for the
user-requested exact saved revision, under existing native approval policy. A
unique eligible project target is automatic; missing/ambiguous targets return
structured clarification for a chat question, not a mandatory publication form.
Manual management previews remain available. Saving locally does not publish.

Receipt states: previewed, pending, published, failed, uncertain. Restarted pending
attempts are uncertain; human verification can resolve them explicitly. Local
UUID deduplication is not remote exactly-once. Do not delete/recreate documents or
activate automatic archive/spec upload as a publishing shortcut.

`publicationPage({expectedRoot,sessionId?,cursor?,limit?})` returns
`{items,nextCursor}`. Limit is 1..50 (default10), with a 2 MiB response budget.
Cursor is the last returned request UUID; it must exist in the current project's
ledger. Missing/foreign anchors conflict rather than restart at page1. The UI
loads older pages explicitly, merges loaded rows, resets on owner changes and
rejects non-progress cursors. Retained older uncertain receipts remain reachable
and can be resolved without reposting. `publications()` is newest50 compatibility,
not an exhaustive ledger. Preload skew lacking `publicationPage` disables only
publication history/publishing features that need this recovery contract, with
full-application-restart guidance at that feature. Scope/search/read/material
save check their own required methods and stay usable when present. Never gate
the entire knowledge API on an unrelated late-added method or simulate pagination
locally. A selected historical
receipt has an explicit read-only
exact-title/body/target/status preview; reviewing it never confirms or retries
the attempt. Keep that view owned by the current project and close it on owner
changes.

## 4. Validation and Error Matrix

| Condition | Required behavior |
| --- | --- |
| Unbound/empty/disabled remote scope | No remote query; explicit not_configured/unavailable state |
| Root A -> B -> A or changed connection/binding | Conflict or denied; no late data/state adoption |
| Foreign/expired source handle | E_DENIED; no unrestricted document fetch |
| Remote ID/collection mismatch or malformed response | Upstream failure, never fabricated empty success |
| Search zero hits | Empty, distinct from unavailable/partial |
| Unsupported or truncated read | Mode/limit visible, no full-read claim |
| Publication target lookup temporarily unavailable | Failed, no POST; do not tell the user to rebind an existing library |
| Snapshot write failure/limit | Degraded evidence; no falsely durable trail |
| External material edit | E_CONFLICT; preserve old/user draft and file |
| Publish content/target/version changes | New preview required before sending |
| Duplicate/unknown publication outcome | Retain receipt; no blind resend |
| Tool/read cancellation | Abort where possible; discard late result, no supplied mark |
| Missing native HTTP support | Honest unavailable/unknown; ordinary dialogue retained |

## 5. Good / Base / Bad Cases

- Good: each project binds its libraries once; a temporary adjustment is visible,
  frozen for that turn and resettable without rewriting native configuration.
- Base: a saved connection without project binding is inspectable but does not
  silently become every project's knowledge source.
- Bad: a model requests arbitrary root/connection/document IDs, a saved setting
  becomes a connected badge, or a remote timeout becomes successful empty search.
- Good: a confirmed material is published after preview; an uncertain result is
  reopened for remote verification without posting again.

## 6. Tests Required

- `knowledge-core.mjs`: migration/backup/protected import, project/scope/handles,
  malformed/partial/denied/cancelled reads, immutable evidence, CAS and handoff,
  exact preview/one POST/restart uncertainty, retention and junction fencing.
- `knowledge-mcp.mjs`: official SDK framing/client cancellation, auth/Host/Origin,
  tool schemas, request-ID isolation, revocation and no late supplied mark.
- `knowledge-mcp-acp.mjs`: actual facade/public runtime with a controlled peer,
  new/load native identity, HTTP=false/unknown, grants/history/permission redaction,
  cancellation and next turn. Fixtures are not real vendor acceptance.
- `knowledge-ui.mjs`: real controlled ReactDOM actions for scope/reset, source
  modes, draft/CAS/material handoff, exact preview/duplicate/uncertainty, and
  A -> B -> A stale rejection plus fresh action recovery.
- `knowledge-conversation.mjs`: real service/files/task creator, SDK workflow
  tools and controlled ACP peer; provenance, CAS, duplicate/restart/crash recovery,
  target clarification, exact publication and uncertain/cancelled results.
- `acp-knowledge-convenience.mjs`: actual owned operation projection, readable
  links, native result deduplication and removal of the copy-answer primary path.
- Typecheck/build and existing ACP/reader/navigation gates remain required. Real
  engine synthesis, deployed WeKnora, proxy/CA and packaged distribution are
  separate acceptance gates. Synthetic real Codex synthesis is evidence only
  for the tested adapter/settings; never infer other vendors or real publication.

## 7. Wrong vs Correct

Wrong: source-relative runtime `require('../../state')` in the bundled Electron
entry, global fallback, grant in permission machine IDs, or one stateless MCP
request handler assuming SDK cancellation will abort its socket.

Correct: statically analyzable module imports after deliberate lazy initialization,
trusted owner/scope capture, exact safe native identities and grant-scoped MCP
cancellation. Keep source evidence, material confirmation and remote publication
as separate facts.
