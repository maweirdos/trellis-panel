# Conversation, document and appearance contracts

## Conversation v2 workbench

Work, Code and authorized ordinary tasks use `ConversationWorkbench`. The host supplies the conversation scope. The composer stays mounted when the first message is admitted or when the user selects another thread. Drafts, controls and reading positions use the host scope and thread identity.

- Render the locally accepted user bubble before awaiting the command. Reconcile it by message ID. A definite refusal restores the original draft or makes it recoverable alongside newly typed text. If admission or delivery is uncertain, query the original command ID.
- The transcript and its sibling controls each have a distinct React key. Mount one visible transcript per workbench. Verify by switching among populated threads and checking both the selected title and the visible transcript.
- The renderer and IPC use `CONVERSATION_READ_PAGE_LIMIT`. A reset within the same storage and thread must preserve valid paged history and the visible anchor. A scope or storage change invalidates the old projection.
- The side panel persists order, selected surface and visibility by authorized scope, canonical project path, parent thread and v2 storage ID. Equivalent Windows path spelling and the initial local workspace identity use the same key. Restore child and BTW tabs only from the current authorized parent's relationship projection. A missing selection falls back to an authorized surface. Restoration reads conversation v2 and leaves engine lifecycle unchanged.
- Attachments for a user input request use the request ID, generation and question draft. The answer UI exposes file selection only when the native request authorizes text attachments.
- Conversation file-change rows render stored patches with Pierre Diffs in unified mode. The renderer accepts both single-file hunk-only history and full multi-file patches. Keep recorded file names and a readable fallback when the patch parser cannot render the data. Run Shiki through its JavaScript backend under the existing renderer content security policy, and verify both syntax tokens and intra-line changes in the conversation route.
- Place live run status beside its starting user message; tool and assistant rows follow their recorded start/create timestamps when available, retaining projection order for rows that lack timestamps. Do not render unavailable reasoning or synthesize provider events.
- During catalog revalidation, retain the last successful suggestions for the same authorized scope and engine. Clear them when refresh fails, the engine disappears, or the scope changes. A suggestion is not an authorization to run a command.

## Named roles and execution engines

Personal conversations use the `chat` route and a real configured assistant by default. The editable draft requires no team membership, logical project, profile chooser, Git repository or Trellis initialization. Native execution starts only on Send. Missing configuration preserves the draft and offers the actual model/runtime settings.

Profiles remain named local project-scoped assistant roles in the engineering console. Its role-library action opens the existing chooser; Codex/Claude Code and Pi are execution engines beneath roles. Install in the relevant panel, refresh from actual returned runtime state, and distinguish installed-awaiting-connection from missing installation. Model controls consume actual connected-session capabilities and acknowledged configuration; the current profile DTO has no persisted default model. Do not simulate team sharing or per-role tool/knowledge isolation. Additional project skills can be selected per role through skillPaths; retain native inherited skills, missing selections and failed-save drafts. Use real Studio metadata and reject stale/hidden/root-changed scan results. Keep current session snapshots separate from edits to defaults for future sessions. Consume the application sidebar width/resize component, including collapsed/mobile reopen behavior.

### Private conversation ownership

The private catalog identifies conversations independently of the shell's selected engineering project and team workspace. Renderer operations carry a conversation ID; native code resolves its fixed workspace and local creator. Work uses a managed durable directory. Code uses a native directory grant. Neither a sidebar selection nor Work/Code presentation changes an executing conversation's directory, native identity or permission principal.

Ordinary conversations have no personal/team classification, space selector or team-project bucket. A team login, membership change or workspace switch cannot partition their history or reset their drafts. Team resources and delivery targets are chosen and authorized by the resource, creation or formal task flow. Do not add conversation sharing, member invites or raw-chat publication. Formal task records, versioned materials and execution facts retain their existing authority. A selected file can become a private creation draft; publishing a fixed creation revision and adopting it into a task use the existing explicit commands.

Keep draft and selection slots separate for each mode and private theme group under the native installation owner. The group UI uses the neutral label `分组`; it is independent of engineering projects and team spaces. Switching those selectors restores the destination slot without moving earlier conversations. Empty drafts do not fill the history list. History selection reads metadata and paged events without starting an engine. Send, cancellation and permission responses resolve the exact native session and generation; hidden or stale replies cannot overwrite the visible draft. The connection limit and cleanup guards remain authoritative.

Private transcripts reuse the native timeline and process projection through a conversation-owned source client. Images and generated-document actions resolve through that client. Project knowledge saving, current-global-root file openers and implicit `.trellis/notes` writes do not belong to this surface. Show only actual selected files and bounded native file results; file presence or assistant prose alone cannot prove a completed task or submitted output.

Both controllers share `ConversationSidebar`, `ConversationWorkspaceHeader`,
`HistoryBoundary`, the composer size hook, `ComposerModelPicker`,
`ComposerUsageIndicator`, `useComposerImages` and the existing preview layout,
tabs and readers. Keep their established ACP DOM classes and global tokens.
Private workspace CSS carries logical grouping, file delivery and archive
structure only; it does not redefine headers, navigation rows, composer depth,
focus, model menus, permission cards or generic spacing.

The conversation header contains the title and a compact More menu. New
conversation remains in the sidebar. Knowledge and New Requirement are labelled
context controls immediately above the composer; Code also shows its actual
directory and source-owned Git state there. Git reads the fixed conversation
directory, never the shell project, and exposes branch/detached/unborn/non-Git
and bounded repository-wide change counts. It does not stage or switch branches.
Files remain reachable from the original plus/More menus.
Context controls use shared small ghost Buttons, normal-weight `text-sm`, an
8px gap between controls and between glyph and label. Do not reuse the bottom
toolbar's negative-margin text-trigger utility in this row. The selected sidebar
surface covers the complete row, including its separate More hit target.
Starting a requirement opens the full `requirement-workbench/Workbench` in the
current conversation surface: formatted document on the left and the existing
private transcript/composer in assistant mode on the right. `assistantPort`
owns its input and projects only receipted requirement turns; ordinary text,
images, focus intent and viewport remain in their original slot. Preserve dirty
documents, answers and quotes across close, source switching and Settings detours.
Transfer ordinary input, recent conversation context and selected file revisions
only through explicit actions. A conservative local requirement-intent projection
may offer “整理成需求”, without a model call, draft creation or navigation.
Its click captures bounded original text and valid selected file revisions and
derives a stable command UUID from the native conversation, creator, text and
fixed references, so reload/lost-reply retries reopen the original draft. Preserve the original request
in the document and enable its selected conversation context. Missing API
documents remain missing; quoted code and unsupported reference sets must not
trigger a misleading automatic handoff.
The original native model, permission and stop
transports remain authoritative. Show real integrated-knowledge connections and
explicit collection/source selection, never an engineering project's implicit scope.
Keep existing drafts and handoffs reopenable from a compact menu beside New
Requirement, including after a conversation has messages and home shortcuts hide.
Each action uses run/observe/adopt with immutable source inputs and a real
validated candidate file after the original native turn completes. Adopt an
explicit workbench action into an unchanged clean draft; otherwise retain a
readable comparison. Questions are editable inputs, not fabricated progress.
Each pane has one aligned compact topbar. Document identity, material tabs,
save status and progression share the document topbar. The editable canvas fills
its pane; formatting and quote/polish controls appear on a settled selection,
with Alt+F10 and Escape keyboard access. Keep the assistant actions at the top
and its original composer docked at the bottom, including the empty state.
Group source selection behind the counted context control. Research without an
actual excerpt/file selection opens that control and waits for explicit continuation.
Confirmation freezes the requirement; Next produces a separate editable plan.
Requirement changes retain and mark the prior plan stale. Handoff selects a real
Trellis engineering directory at the plan step; Work's managed directory is not
that selection. Create a planning task with both fixed documents and provenance.
Execution preparation verifies official task activation and an ordinary native
origin, then uses existing managed workflow preview/start and phase controls.
Preparation is not running; navigation is not execution. Team association and
formal review keep their own explicit business commands.
See `docs/requirement-workbench.md` for the end-to-end behavior.
An empty conversation groups its introduction, context and original composer
around the content center. After a real send, the same composer DOM docks below
the transcript without losing focus, IME state, images or scroll ownership.
Below the empty composer, show conditional shortcuts for a real resumable
conversation, an actual requirement draft/task and selected local materials.
Do not invent tasks, completion states or unsupported group-chat actions.
The welcome heading uses the existing display type role; supporting copy uses
`text-sm` and tertiary color. Context controls and editable content retain their
own control/chat roles rather than inheriting the welcome title size.

Reuse the original list-row hover/focus preview, management menus, keyboard
search, rename, pin and archive/restore interactions. Archived records remain
readable and recoverable in Settings / Storage data management; archiving never
stops an executing native session. Ordinary history, group trees and their search
contain active records only, even while an archived record is read explicitly.
Legacy transcript archives also belong in data management, not the sidebar.
Keep unsupported actions absent rather than simulating native results. Empty
project groups and empty legacy archives do not occupy permanent sidebar blocks.
An existing native history without cached preview uses an unread-summary state,
not an empty-conversation claim; a loaded preview uses actual native metadata.

The model picker receives its actual configure transport. Private operations
carry a conversation ID and expected native generation; model recovery may
replace the generation only through its own acknowledged recovery request.
Image drafts use the original bounded image reader and source-owned memory,
including before the first native session; image bytes never enter text-draft
preferences. Preview resolution follows the actual session's source through
the native catalog, not the engineering project selected in the shell.

Keep private history rendering bounded with explicit load-more controls. Closed
groups do not need every child mounted. Knowledge actions identify any existing
engineering source explicitly; a personal conversation without an engineering
project can select files and manage connections without entering Trellis setup.

### Conversation continuity and compact controls

The conversation header prioritizes the title. Channels remains reachable from
the compact module switch; Refresh is direct when it is the only management action,
and End Conversation uses the shared More dropdown. The current-turn Cancel action
stays directly visible in the composer action position while applicable. Keep all
existing operation guards and exact session/connection authority.
Use an icon-only stop control with an accessible name and stopping state on every
conversation surface. Keep the composer controls on one line, with the current
permission mode identifiable and its actual scope available in the menu. Group
retry and historical permission records behind disclosures; keep current permission
requests, actionable choices and failure reasons visible. Current activity follows
the owning turn's latest observed state rather than reporting a stale waiting state.

Transcript and composer share `my-conversation-column` within the same
`my-conversation-frame`. Use symmetric scrollbar gutters, explicitly overriding
the generic shared scrollbar rule, so both columns have the same measured edges.
The composer grows/shrinks within global height limits after draft, font or width
changes; it must preserve its DOM/ref, draft, IME submission and reader ownership.
Disconnect its width observer while the retained source is inactive. Ordinary
Trellis events use the neutral `my-activity-note`; errors and pending permission
choices retain their distinct semantic presentation.

Selecting history reads its transcript without connecting or stopping an engine. Keep per-session drafts, images and references across selection and Settings detours. A continues in the background while B can submit independently. Explicit Send reuses a healthy owner, joins a new session's pending start, or restores the same native identity before exactly one prompt. Do not replay prompts, replace conversations or reconnect from status updates. Failed load/capacity admission preserves input and offers an explicit retry. Legacy transcript-only records remain read-only; external locks/provider restrictions remain authoritative.

Normal connection preparation is an internal lifecycle, with one neutral,
compact feedback location. Keep loaded history and the editable draft visible;
do not repeat a connection/reconnection banner in both the header and composer.
Sending uses the continuous preparation/reply state rather than alarming
`正在连接原会话` wording. Only failed, timed-out, uncertain or cleanup-required
preparation exposes the existing actionable recovery details. A historic active
status with `connectionOwned=false` does not prove a running process and must not
create an endless spinner or block a resumable conversation. A current metadata
read can prove a reusable healthy connection before invoking resume; metadata
read failure alone cannot invalidate the main process's acknowledged live owner.

After Send-time resume, rebind submitted references to the new generation only
when fresh project/task and backend/native session identity prove continuity.
Backend source revision checks remain mandatory. Missing or changed identity
preserves the original references and rejects sending.

The composer hosts native mode, collaboration, model, reasoning and remaining advertised configuration through anchored shared Dropdowns. Prefer a unique advertised category=model/mode config option when session/set_config_option is supported; fall back to legacy controls only when advertised. Use one local configuration lock and apply choices only after acknowledgement. A reasoning track contains exactly the engine's returned options, never invented strengths, permission presets or default reset. Remove duplicate current-session forms/select autofocus from the inspector; retain environment context and a return-to-composer action. Internal menu scrolling must not dismiss the shared Dropdown. Do not restore below-composer task/keyboard hint rows; retain actual task entry and IME-safe submission.

Real tools and nonempty thoughts use compact icon/label records with details
behind explicit expansion. Successful startup/transport milestones, usage and
empty-thinking diagnostics remain recorded for inspection and never appear as
a process checklist. A completed response preserves the input and live connection.

`ConversationTranscript` groups the compiled rows by exact root, runtime source,
session, connection generation and turn. During execution, keep commentary in
chronological order and collect only adjacent real tool/thought/knowledge work
into compact, initially collapsed segments. A later commentary closes the
preceding segment into a static summary; the active segment uses actual current
state. Expanding a live thought segment shows its text directly, without a
second nested thought disclosure. Bound expanded
detail height and retain keyboard/wheel access. Show `已处理 <elapsed>` only
for a real recorded start and the exact current live owner, with no repeated
screen-reader announcement on each clock tick. Missing terminal history cannot
establish a running turn.

After that exact turn receives its terminal event, collapse the process into
one `用时 <duration>` disclosure. A duration requires both a recorded start and
end; partial history uses `处理过程`. Keep the existing duration formatting.
Its expanded content is a flat chronological sequence of narration and process
leaves; do not render live segment wrappers or a second completion summary there.
User messages, final answers, completed
delivery cards and pending permission choices remain outside. A successful turn
does not acquire a red error icon or issue count from individual failed tools;
their actual failures remain readable at their recorded position. Failed
terminals use the inline failure disclosure described below. Cancellation
retains its distinct `已中止` state.

Keep `TranscriptTurn.entries` in recorded order. At terminal settlement, final
answers, failures, permission requests and delivery records preserve that order;
moving a failed terminal above an already visible answer changes its meaning.
Private design cards use the original completed tool's exact root/source/session/
generation/turn and the verified imported document. Render one document card at
its first loaded producing turn, not as a footer on every new turn. Designs whose
origin is outside the loaded page remain accessible as explicitly labelled saved
designs above the transcript. Hidden copy actions use an overlay instead of a
reserved row, while remaining focusable.

Selected input references are separate from stored input files. `selectedInputIds`
is an explicit, installation-owned next-message selection; a missing selection
means none, including older caches. Import and the file-panel action select inputs;
loading metadata never does. Cancellation never deletes the original file.
Persist `inputReferenceVersions` and capture them in
`submission.fileReferenceVersions`. Native user-message or original receipt proof
consumes only captured, unchanged selections: adding B must not preserve old A,
and reselecting A must protect the new A. Process reference consumption before
clearing an in-flight submission, including when the event precedes the send reply.
Root replacement resets reference state; restoring cache preserves newer selections
and both newer text and any unresolved original request.

Image history reads are lazy, shared by exact source/root/session/image, bounded
to two concurrent native calls, and cached within 64 entries and 28 MiB of string
storage. Retain failed reads until an explicit retry; retry only transient failures
and preserve successful images. Missing/digest-invalid images disclose the reason
without an ineffective Retry. Do not render the same stored image twice in one
owned turn. A hidden or changed source cannot apply a late image result.

Requirement intent may carry the original idea and bounded user follow-ups from
loaded history. Recognize explicit business-requirement discussion and retain
context through “继续”; quoted/code examples, rejection and unrelated greetings
cannot trigger a handoff. The click remains the only transition into the workbench.
Use `page.discussion` independently of visible paging. Preserve user answers with
assistant questions/proposals; proposals are not confirmed facts. Explicit
formulation requests have their own dismissal anchor. Memoize intent and design
receipts across scroll-only changes. Closed process groups mount their readers
only when expanded; actual failures and deliveries remain visible.

Catalogue readiness does not wait for engine discovery or legacy archives. Read
metadata/history independently, validate both page and discussion owners, render
valid history first, and preserve newer edits. Coalesce reads for the same creator,
conversation and root. Reset `readTimings` for each measured read.

Private text links use `readFile` with fixed revision/source identity and the
shared Modal. Show actual pending/error state; adoption requires verified body.
Last-read identity and interaction epochs fence late replies; closing cannot be
undone by a reply. Adopt selected saved drafts through existing requirement APIs
with fixed PDF/document references. Stable adoption commands reopen saved edits.
Do not depend on Windows Markdown associations. Pre-optimize lazy Tiptap packages
in development and create the editor after commit (`immediatelyRender:false`).

One pending-user item owns delivery feedback; CurrentTurnStatus and composer
controls do not repeat submission progress. Configuration spinners represent actual
configuration/startup. Request/provider/thinking/read/save labels use real events.
Recognize `pi_model_request` and `pi_provider_response` as routine structured
runtime progress after checking error severity. Keep their original events for
the current-stage projector; do not duplicate them in transcript process rows.
After 15 seconds without new displayable content, a scoped one-shot hint may offer
waiting or stopping. Preserve the original elapsed clock; invent no percentages,
content or hidden reasoning.

### Requirement editing and team handoff

Common paragraph, bold, list and undo/redo controls are visible in the document
toolbar; narrow editor containers retain the full menu and Alt+F10. Selection
actions expose quote and polish. Position review near the captured selection
without changing document layout or scroll. Preserve document/version/text/anchor
fences for replacement. A closed review cannot reopen from a late result.
Polish uses requirements.polish with its own command identity, signal and status;
it never calls the main conversation run/send or changes its stop state. Keep one
local candidate review. Technical receipts remain separate from draft.operations.
Closing a running request cancels its exact ID even if registration replies late.
Closing an already submitted adoption preserves its original recoverable receipt.
Delayed menu updates require a mounted, initialized editor view.

Prove Markdown offsets against the original bytes by parsing candidate source
ranges with a unique marker and comparing the resulting ProseMirror structure.
Unrelated table/whitespace serialization cannot invalidate an unchanged paragraph.
Require one structural match, unchanged visible body/revision and current native
source before local replacement. Source changes offer reselect; no forced replace.

Existing documents expose Continue Requirement and View Plan beside New
Requirement. Scope remembered draft, selected document and independent rich/source
scroll positions by creator, conversation, physical root and draft. Restore only
an actually listed original ID; preferences cannot create a replacement document.
Requirement/plan navigation stays in the document header.

The action bar shows draft/confirmed/plan-source state and existing sources.
The workbench's file-source panel exposes the existing private conversation
file picker without requiring a model or leaving the draft. Reuse `addFiles`
and its original conversation identity, pending state, refresh and error
projection. Disable import for inactive, read-only or busy workbenches. A
cancelled picker preserves the draft and existing references. Imported files
remain private; fixed requirement references are selected separately and team
sharing still requires the existing explicit publication action.
Design references belong to the corresponding modify action; selecting sources
does not rewrite the document. Plan generation displays the saved requirement
version and unanswered required questions before dispatch, then requires explicit
candidate comparison/adoption. Preserve stale-plan feedback after edits.

The conversation menu offers creation and binding. Creation runs in the original
conversation and reconciles its request after reentry. Binding selects an existing
task without sending a model message. A confirmed receipt stays in the chat.
Activating its number opens the post beside the same mounted composer. At narrow
widths switch between panes while retaining both reading and input state.

An independent document opens from the conversation's documents menu. Handoff
rereads the saved revision, shows its destination and optional attachments inline,
and uses the exact body as the task's initial text. Keep the form mounted during
its own submission. Bind the conversation in the creation command. Later shares
publish a named version to that task. Scope feedback to the workspace, account
and source conversation. Only a user action opens the task.

From a team post, “问 Agent” opens the current member's private conversation.
Reading or binding never sends a question. Sending alongside the task resolves
the authorized post, comments, active clarifications and versioned material in
the main process. Identify unread sources. A public comment requires a separate
send. Returning restores the originating post and list position or filter.

Team handoff bootstrap shows checking before any permission conclusion. Distinguish
offline, access-revoked, local/no connection, empty workspace and actual membership.
Use the existing account/workspace panel and retry reads. Preserve the original
authority/space; passive refresh cannot choose another target. A bounded unsent
handoff form cache may survive transient revocation only under that exact original
handoff/authority/space, and can be restored after access is verified. Keep global
task-draft authority fences and submitted native command recovery unchanged.


`readableTranscriptEntries(entries, events)` selects human-readable process
records from compiled items without rewriting saved events. Activity aggregates
can contain earlier transport observations at turn completion: extract genuine
problem events as scoped leaves and omit the aggregate presentation. Exclude
successful terminal rows, routine observations and `pi_thinking_empty` notices.
Use structured event facts rather than filtering arbitrary assistant/tool text.

`TranscriptProcessLeaf` owns record content only. The turn owns completion and
timing; a live segment owns its disclosure/activity. Process rendering must not
delegate activity/thought records to legacy `RunActivity`/`ThoughtActivity`
widgets. Tools, permissions, knowledge actions and deliverable readers retain
their actual callbacks and source ownership. Only a real matching active leaf
can take over the host's current-turn feedback; transport or empty groups cannot.

Tool patches retain their original scoped row and first-event anchor. Replay
authoritative Pi text updates before compilation through
`replayConversationTextEvents`; the saved event log remains unchanged. Use the
provider's `commentary`/`final_answer` phase when available. For unphased history,
only the last uninterrupted assistant message at a recorded terminal is an
answer. Do not classify prose by its wording. User messages have a hover/focus
copy action and a theme-owned `--my-bg-user-message` surface. Ordinary assistant
messages, including final summaries, have no whole-message copy button. Copy
belongs to an explicit document/reader or code block and copies that displayed
artifact. Rendering prose through MarkdownView does not make it a document;
headings, lists or code fences cannot establish document identity.

Use the same `event-order.ts` reconciliation in live and paged-history merging.
Saved sequence is canonical, while overlap IDs anchor already delivered unsaved
prefixes before the saved suffix. New unacknowledged tails retain delivery order
even when the clock regresses. Never sort all sequenced events ahead of every
unsequenced event: a suffix refresh would move older live turns below newer ones.
An in-place patch that adds no visible row must not split one native Markdown
message (especially a code fence); actual new tool/thought/status rows remain
visible boundaries. Test partial sequence upgrades and full replay, not just
entirely sequenced or entirely live arrays.

Process records are secondary to the answer: use the shared small font/tertiary
label color (default12px versus answer14px),14px icons in16px slots,12px chevrons
and24px rows. Keep explicit expansion local and preserve source keys. Never
fabricate a completed step or start/duration for a partial prefix, or an arrow
for an empty disclosure. A successful turn has exactly one completion/time entry.

Acceptance must replay actual saved event shapes through compile, projection
and mounted transcript, including terminal aggregates containing start/sent/
first-provider/first-visible observations, with and without thought text. Check
running, expanded running, terminal collapse and expanded terminal against the
reference layout in both themes. Assert no legacy activity/checklist DOM, no
empty-thinking placeholder, one completion entry, flat terminal process and
accessible tool/thought/error/permission details. Simplified text/tool fixtures
alone cannot establish this visual contract.

The same compact leading-icon geometry applies to top-level knowledge results,
file reads, commands (including failures), thoughts and the current-turn status:
one column-edge 16px slot containing the 14px glyph, followed by a 6px gap and a
shared first-label origin. Do not give these row types independent 6px/4px/0px
horizontal inset or rely on their JSX SVG size props alone. Preserve 12px
chevrons and matching vertical centering/stroke. Intentional nested source/detail
indentation and step rails remain nested; an iconless completion footer does not
acquire a fake slot. Mounted geometry tests must compare actual SVG-slot/label
bounding rectangles between row types in light/dark, each supported font size and
narrow layout. A font-only or string-presence check cannot prove alignment.

### Continuous current-turn feedback

The current-turn status is a separate, ephemeral tail affordance, not another
persisted timeline event or a placeholder in the composer. It appears immediately
when a valid send starts, before RPC acknowledgement or any engine token. It
remains visible through genuine processing gaps between thought/tool output and
the next assistant text, using actual local request/current session state rather
than requiring a newly received transcript event for every frame.

Use one compact neutral icon/text status (`role=status`, labelled `当前回合状态`)
after the latest content. Local submission can say `正在发送…`; current-turn facts
may select waiting/thought/tool/reply wording. A label may not claim an unreported
search or phase. Awaiting permission is an explicit user wait without a working
spinner; cancellation reflects the actual stop request. Honor reduced motion and
suspend hidden-source animation. Historical observation rows retain their anchors
and wording; avoid duplicating the overall running indicator in those rows.

Correlate local submission and acknowledged handoff by exact root, session,
connection generation and returned turn ID. An acknowledgement arriving before
the corresponding busy state must not create a blank gap or re-enable duplicate
submission. A previous turn's completion must not hide a new local send. A matching
terminal event ends the status even if metadata still says busy; rejection, throw,
failure, disconnect and owner replacement clear it without losing the unsent draft.
Never revive an old spinner from completed history or a foreign/stale result.

Private conversation Send moves captured text into a local pending message after
retaining recoverable text; the composer stays editable while native admission
is delayed. Definite failure offers input recovery, and unknown delivery offers
original-request reconciliation. Neither operation overwrites a newer draft.
Keep live activity at the content tail; recorded process disclosures use static
type icons. A native connection error suppresses unverifiable nested activity.

Upward wheel/key intent suspends following before layout effects run. Retain a
visible text anchor during updates and pagination; browser anchoring and manual
compensation must not both move the transcript. Reaching a near-bottom threshold
alone is insufficient reason to pull a reader down repeatedly.

Connected reasoning changes preserve the open popover and focus after native
acknowledgement. Display a scoped zero-effort label such as “推理关闭”. Offline
resumable conversations expose explicit connection recovery, while actual busy
work retains its existing wait/stop constraints. Mode descriptions use
`DropdownItem.description` and content-sized multiline geometry. Both pickers
offer an explicit future-default action independent of current model selection.

Hide the initial empty-conversation invitation while a request is active. An
explicit valid Send opts into following the latest content so its immediate
status is visible. If the user then scrolls up, passive chunks/phase changes
respect that reading position; they never opt back into following on their own.
Tests must hold IPC/state/output separately to prove immediate
submission, acknowledgement handoff, silent gaps, terminal-before-ready, failure,
selection/generation/root drift and Settings suspension using actual components.
Verify projection and real controller callback races in the actual Console with
independently delayed IPC, state and output, including silent gaps and
reduced-motion behavior. Temporary validation scripts belong in OS TEMP.

### Native knowledge calls and explicit new-conversation focus

`projectCurrentTurnActivity` selects actual current knowledgeOperation facts
before generic waiting. Ordinary sends have no host retrieval preparation phase.
Native search/read events appear only when a tool actually runs. Historical
preparing questions and promptDelivery receipts retain their original projection;
a completed historical lookup alone does not establish native delivery. Keep one
current-turn working indicator; historical tools remain static and readable.

Successful turn-scoped `开始处理`, `指令已发送至引擎` and `收到首次模型响应`
observations remain stored but appear only in the terminal processing disclosure,
not as pre-question or standalone success rows. Preserve meaningful thought/tool
chronology and explicit failures/permissions; do not rewrite history ordering.

Completed `KnowledgeOperationRow` defaults to a single compact result disclosure.
Only explicit expansion resolves its actual source IDs through the existing
local source-snapshot API; never launch another retrieval. Put all real titles
with source kind/full-or-excerpt mode and existing reader actions inside that
disclosure. Collapse must hide the actual list, not merely a description while
leaving documents outside it. Late snapshot completion may not reopen it.
Successful generic scope chatter (for example `已检索本地与项目远端范围`) adds no
information and is omitted; genuine failure/partial/degraded/omission detail
remains accessible. Retain exact source/turn ownership, original bounded body and
supplied/historical truth. Never infer sources or model reliance from answer
prose. If the bridge or snapshot is unavailable, show the real read failure
rather than invented titles.

After explicit conversation creation, retain one focus intent scoped to root,
returned session, connection generation and interaction signal. Focus the mounted
editable composer after the chooser closes and the session becomes ready, once.
Opening Settings/another dialog, changing source/session, or deliberate keyboard/
pointer interaction cancels pending autofocus. Passive refresh/streaming never
refocuses. Preserve IME and drafts. An explicitly selected empty conversation
remains in conversation view on list refresh/remount; paged-history hydration
must not run against an empty legacy list before that list has returned.

Mounted regressions must hold lookup completion and native dispatch separately,
verify one status/working animation, default collapse/late completion/expanded
source reading and actual list hiding, inspect
light/dark reader title colors, retain static pending history, and test delayed
ready/list/chooser focus with Settings and selection cancellation. Match the
production themed host for portal tests, not just the embedded conversation.

Running headers show actual elapsed time with a visible current-step spinner; terminal completion/duration requires an actual turn-done event. Busy/permission/cancel/tool/thought/reply labels use matching live facts, never another turn. Raw JSON is separately requested and lazily rendered; it cannot substitute for readable status content. The subtle vertical rail connects actual nodes only; a single node has no dangling rail. Suspend the timer for hidden retained sources and honor reduced-motion. Actual setup observations may be shown as context for the first real turn of that exact connection only, without generating a new transcript entry or reassigning their original identity. Do not duplicate the same startup facts in a top-level startup panel and the timeline group.

Latest user override: do not render raw activity/connection JSON entry points. Usage_update is not an activity step; ComposerUsageIndicator sits immediately before model selection and shows actual context occupancy in a static ring with hover/focus details. Use only the current connection's reports, clear stale values on acknowledged model changes, preserve unknown as unknown, and never infer model capacity or sum updates. Other readable process/tool/thought content is retained.

ProjectRunProgress represents only actual scoped stages, not a reason to reorder the transcript. Admission starts sending; prompt-written starts waiting; actual model content starts generating; terminal completion finishes the current stage. Unknown history, failure, cancellation, routine metadata and empty thoughts cannot acquire successful checks. Connection preparation occurred before sending and remains available as its own earlier segment or in connection inspection; do not duplicate it inside every later processing segment. Do not animate/replay stored milestones to simulate execution.

Latest compact-presentation refinement: constant sync/available-command notifications do not occupy the transcript (retain stored facts). Prior connection context uses a concise confirmed-ready summary with real duration and readable observations on expansion. Segment details describe their own real observations, rather than replaying a global phase rail. Only the active thought segment includes a bounded, rolling preview revealing already-received characters; hide that line on reply/tool/plan output or turn end, and never show it for history. Full thought content remains expandable. Stop presentation timers after catch-up, when hidden/open, and on unmount; reduced-motion skips typing.

Keep the default composer to plus/current mode at left and usage/combined model+reasoning/send at right. Existing task/machine context, actual advertised plan/collaboration choices and other parameters move into plus. No reference-only attachments, plugins or fictional plan mode. An active plan may have a small acknowledgement-backed badge, avoiding duplicate labels. The one model dropdown contains native model choices and the native reasoning selector. Exact original IDs, shared configure lock and runtime acknowledgement are unchanged.

The plus menu contains actionable commands. Binary native default/plan choices use one toggle and return to a known original mode. The composer model control opens the shared searchable list. Reasoning controls show options reported by the active engine and apply through its existing configuration acknowledgement.

Real image attachments are available through plus, clipboard image paste and composer file drop. Show rounded thumbnails above the textarea, an accessible hover/focus remove action and explicit shared-Modal preview; sent images remain above their user message and persist in history. `useComposerImages` owns in-memory drafts per root/session, never base64 in localStorage. Async reads/file-picker completions require the exact active source/session/connection/interaction owner; switching away and back cannot revive an old operation. Hidden/unmounted sources cannot open previews or steal focus. Only accepted submitted IDs are consumed; rejected sends preserve attachments and later additions survive acknowledgement. Block submission while image reads are pending. Permit image-only input, check the actual advertised image capability and explain unsupported/unknown capability without silently dropping attachments. Share count/byte/MIME limits with main; provider-specific vision is not implied by the engine capability.

In private conversations, clicking send moves the captured text and images together from the composer to one pending transcript row. Pending and recorded user messages show 96px square thumbnails above the text, right-aligned and wrapping within the message width. Replace the pending row with the matching native user message on confirmation. On confirmed non-delivery, keep the failed row and offer direct resend of its original payload when all attachments are available. Resend creates a fresh request and preserves any newer draft. Allow removal of confirmed failed rows. Keep pending image bytes in memory and preserve the original request identity while its outcome is uncertain.

Filter explicitly connection-scoped events and recognized structured historical connection observations out of the transcript without deleting them. Do not hide arbitrary unknown diagnostics using broad text matching. Connection/protocol details remain available in the session inspector. The header alone shows background connection progress; no startup checklist is appended after an old answer. Track automatic attempts over the source lifetime, not individual selections; records with failed status require explicit retry, even after remount. History, draft text and source references remain readable while connecting.

## 1. Scope / Trigger

Read before changing `acp/`, conversation framing, reader hosts or Settings appearance. Compose existing protected controllers/readers; the design prototype is not production transport, state or Markdown infrastructure.

## 2. Signatures

- `useMy`: `fontSize: 'small'|'standard'|'large'`, `setFontSize(size)`, `syncFontSizeFromStorage()`.
- Preference: `tpanel.my.ui`; App roots expose `data-my-font-size`, including independent windows. Storage events synchronize appearance without replacing unrelated preferences.
- `ConversationDocumentPane({projectRoot,sessionId,connectionGeneration?,taskDir,relativePath,expanded,onToggleExpanded,onClose,onReference,onDisplayedReference?})`.
- `onReference(AcpSourceReference)` captures displayed bytes and original target; `onDisplayedReference(ref|null)` is a current reading fact, never approval.
- `projectConversationArtifacts({projectRoot,taskDir,artifacts,changes?,events?})` projects actual scoped inventory/material facts.

## 3. Contracts

### Layout and shared styles

ACP owns one internal module header and bypasses the former outer PageFrame; retain the fixed module rail and reachable Agent/channel switch. One inspector selects Agent/task/document. Keep the same document host across inspector tabs, expansion, responsive and font changes; explicit close/file/session/root changes end the appropriate lifetime.

Use shared Button/Dropdown/Modal/Escape layers and `my.*` tokens. Standard Button forwards accessible/data attributes. Font controls exist **only in Settings**, never the home/conversation top bar. Standard is the unset/invalid default: UI/chat/document all use14px; explicit small/large use13/15px respectively. Activity uses --my-text-activity (standard12px). Consumers use `--my-text-ui/chat/document`, line-height and control/row/header/avatar variables. Shared inputs consume the UI font variable; multiline inputs explicitly override single-line height.

Recent rows are single-line titles (standard32px, from the global row metric). After about350ms hover/focus, show a small viewport-clamped hint with existing title/description/context; do not activate the conversation. Attach `aria-describedby` while visible. Escape, scrolling, navigation and scope changes dismiss it. No persistent description/metadata rows.

The hint summarizes the coherent latest message/response, not the last streamed token event. Assemble only compatible role/turn/session/connection chunks, exclude thought/tool/diagnostic text and older turns, then normalize whitespace and apply the display bound. Verify with actual fragmented streaming records; a single static message test cannot catch a one-word summary.

A diagnostic event is not automatically an error. The structured adapter-native capability fact (`toolExecution='adapter-native'`, client filesystem/terminal callbacks both false) is neutral, collapsed runtime detail with original text/raw payload inspectable. Explicit warning/error/auth codes and failed tools take precedence and remain visible. Do not hide unknown diagnostics or use a text-only match to suppress a failure.

### Conversation web previews

Only validated `piWebPreview` metadata on an actual Pi assistant message in the
selected root/session establishes a web preview. Transcript rows show a compact
artifact card with an `onOpenWebPreview(artifact, eventId)` action; they do not
own an iframe or server lease.

HTML/SVG code blocks retain their source and compact preview action.
`CodePreviewProvider` supplies a source-scoped
`openCodePreview(source, language)` action to the conversation's Markdown
descendants. Route snippets to the same right pane using `PrototypePreview`
for HTML and a static image for SVG; never write a file or acquire a file lease.
Without a host, use an inline preview. Store only source data in per-session
memory; keep callbacks in the mounted Context and reject inactive/stale owners.

`usePiWebPreviewShelf` owns tabs, selection, collapse and expansion per
root/session. File tabs deduplicate by path; code tabs by language and source.
Keep at most four file leases and eight total tabs; reaching the limit preserves
existing tabs and shows a close-tab action requirement. New preview events select
their tab while visible; a collapsed pane stays collapsed. Closing the last tab
or collapsing suppresses reopening from the same event, including history refresh.
Returning to an open session restores its selection.
Opening Inspector closes the preview, and opening a preview closes Inspector;
preserve existing task/document state and the conversation draft.

`ConversationPreviewLayout` keeps conversation and preview in a desktop split,
including narrow windows. Expansion changes pane width; it never opens a Modal,
scrim or overlay, traps focus or makes the conversation inert. Keep the left
conversation mounted and the iframe filling the right pane below its controls.
Use `usePointerResize` for pointer capture and interrupted-drag restoration.
The labelled separator supports arrows, Shift for larger steps, Home/End and
double-click reset; constrain width to keep both panes reachable.

`ConversationPreviewTabs` remains mounted when collapsed. Hidden panels are inert
and retain their iframe and lease; switching tabs or changing width must not
reset page state. A compact edge action reopens the pane. Support ArrowLeft,
ArrowRight, Home, End and Delete in the tab strip and restore focus when closing.
`PreviewToolbar` centers a read-only, selectable source/actual lease address.
`acpPiWebPreviewOpenExternal(leaseId)` opens only the main-derived owned URL in
the system browser. Code snippets are unsaved and have no external-open action.

`PiWebPreview` acquires a lease through `acpPiWebPreviewOpen` for each file tab and
current root/session/connection. Release that exact lease on tab close, owner
replacement, scope suspension or unmount, including a late open response.
Reject stale callbacks and invalid non-loopback preview addresses. Poll
`acpPiWebPreviewStatus` without overlapping requests; remount the iframe only
when its actual revision changes or reload is requested. Hidden tabs collect
revisions and apply them when activated. Show actionable errors and retain reload
and close controls. Verify live-to-terminal folding, replay, copy targets,
light/dark contrast, tab/iframe continuity, collapse/reopen, actual source updates
and foreign/stale owner rejection using mounted components and isolated files.

### Sources and workflow

Only real inventory or matching `source='trellis',kind='material-change',payload.materialChange` establishes a file fact. Prose cannot prove an artifact or author. Material arrival never steals focus or forces scrolling/reading. Displayed A/base remains stable when B arrives; compare/read-new and copying displayed content are explicit.

Quote creates an editable source-bound draft, manual send only. Failure retains text/references. Restore cannot silently retarget an old connection reference: offer deliberate re-reference, preserve old draft/chips, and filter old generations out of newly prepared planning instructions.

Planning and implementation intents differ; switching conflicting generated intents retains the original draft. Review requires **full principal paths** under the bound task, never basenames: `research/.../prd.md` cannot satisfy the principal PRD. Use shared full-path equivalence for Windows drive/UNC case/separators; preserve POSIX case. Lightweight PRD-only scope is explicit; otherwise require displayed principal PRD/design/implement refs. File presence/reading is not formal approval; the Agent/local workflow remains phase authority.

### Reader ownership

Use independent hook-host reading keys while retaining real taskRef/source. Presentation is not identity. Gate initial/reload/change/apply/diff/watch completions by owner/request generation, retaining readable content on failure. Follow [exact watch leases](../backend/document-watch.md); never fall back to path release.

Settings-only font controls require the complete ACP → Settings → ACP journey to retain that same reader, rather than merely retaining draft text. Follow [retained-source interaction contracts](retained-source-interactions.md): bounded source owner, independent data/watch and interaction lifetimes, hidden Escape/portal/focus suspension, and exact root/other-route cleanup.

Heading discovery must use the same CommonMark line-ending semantics as body rendering: CRLF, LF and lone CR. Normalize only the parser's line view, never the displayed source bytes or revision. Keep source line numbers, duplicate-heading IDs, code-fence exclusion and section quotation consistent. A CRLF document with visible headings must enable the outline and navigate/focus the corresponding rendered section; body rendering alone is not evidence that outline extraction works.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Missing/invalid appearance | Standard; retain unrelated/legacy preferences |
| Font change | Tokens update, draft/reader/runtime identity retained |
| Stale/empty diagnostic active ID | Useful library entry, secondary history preserved |
| Root/session/generation drift | Reject stale callbacks/refs, preserve scoped draft |
| A reference with disk B | Main rejects before turn; explicit compare/read/re-reference |
| Nested same-name planning file | Cannot satisfy principal review |
| File deletion/read failure | Honest diagnostics, no successful blank replacement |
| Hover/focus without click | Hint only; no session/start/send |
| Topmost hint/menu/diff + Escape | Close that layer only |
| CRLF/LF/CR Markdown with headings | Same outline, stable IDs/line numbers and version-bound section quotation |
| Image selection/read/send across session or root changes | No cross-source attachment/focus, rejected drafts retained, only accepted submitted IDs removed |

## 5. Good / Base / Bad Cases

Good: A displayed, B pending, font/expand changes retain A and draft. Base: unbound discovery requires explicit idle task association. Bad: a nested research PRD counts as principal review, or restore silently updates an old authorization reference.

## 6. Validation

Run `npm run typecheck`, `npm run build` and static `npm run check:ui`. Keep temporary validation code, IPC peers and captures in OS TEMP.

Verify actual controller/IME/draft/follow/permission/root/restore behavior and explicit recovery. Reader validation must cover multiple owners, deferred acknowledgements, provenance, release, CRLF parsing, outline/loading/navigation/focus and section quotes. Inspect appearance persistence and real light/dark/narrow/focus behavior; controlled results do not close native/vendor acceptance.

## 7. Wrong vs Correct

Wrong: transplant demo state/palette/Markdown, add a font switch to the conversation header, or equate basename/read facts with approval.

Correct: compose production shared components/controllers/readers, change semantic tokens from Settings, capture exact current source/target refs and preserve workflow authority.

### Saved product-document Modal

Saved knowledge artifacts use a dedicated read-only Modal presentation, not a
task-file reader or a new sidebar/editor. Keep exact receipt ID/revision/body;
disk B must never replace previewed A. The primary entry is a human-readable
document-name/actual-format link backed by the saved record, not a second View
Document button or a guessed file from model prose. A matching Agent-answer link
may open that same saved revision only through its verified causal receipt.

Use one main document title hierarchy, scoped reading width/paragraph/heading/
table styles, optional real chapter navigation and secondary raw/document-info
controls. Internal paths/hashes are not the default visual headline. Preserve
raw bytes, heading line anchors, independent raw/rendered scroll and shared Modal
focus/Escape behavior. Root/session/generation/Settings replacement invalidates
late opens and resource results; passive document arrival never opens the Modal.

`MarkdownView.documentAssetContext` activates the bounded project-relative image
path only for saved-document reading. Ordinary Markdown/source/task readers do
not acquire broader resource access. Valid Mermaid remains strict/sanitized.
Pictures are current local resources, not archived image revisions; present that
truth rather than promising Word/PPT layout or inventing diagram content.

The optional local-open action is secondary and means the current local file.
A different revision requires an explicit second action; keep the original
preview unchanged. Missing new preload capability produces restart guidance,
not a generic arbitrary-file fallback. Follow the full signatures, limits and
error contract in [saved knowledge reading](../backend/knowledge-document-reading.md).

## 8. History-first reading and recovery presentation

The conversation surface reads compact `AcpHistorySummary` records and loads transcript pages independently from native connection state. History loading failures retain the selected transcript cache and provide a history retry; engine readiness does not imply history loaded successfully. Native resume begins only on explicit Send or retry. Older pages are prepended with anchor/scroll compensation; live appends follow only when the reader was already at the bottom.

Partial loading means fewer complete turns, never the middle of a saved reply.
`acpHistoryEvents` aligns both page edges to turn boundaries; its count/byte targets
may be exceeded for one intact turn. Render and merge that whole page without
reapplying a local event cap or slicing Markdown text. `startsMidTurn` is reserved
for a source whose opening is already missing/unverifiable, and its optional
explanation says `未找到这一回合的开头记录`. It must not excuse ordinary pagination
cuts. Keep running tails genuinely running; loading history does not create a
completion result or a missing original prompt.
With the versioned history APIs available, `updateSession` uses state/resume
snapshots for session metadata only. Their bounded `record.events` tails must not
be merged back into the transcript, since they may reintroduce half an older
turn outside the selected page. Saved content comes from history pages and fresh
content from scoped `onAcpOutput`; the legacy API path retains its snapshot
fallback. Test both suppression of a truncated snapshot and admission of live
output after the same state update.

The sidebar contains one compact single-line conversation list. The engineering
console keeps its explicit diagnostic filter; private conversation archives and
legacy transcripts live in Settings data management. Do not add a second History
destination, loaded-count filler, persistent multiline previews or invented
notification actions. Rows keep the delayed coherent hover/focus hint and existing
resize/collapsed/mobile behavior. Metadata search must state its actual scope.

Conversation rows expose a compact menu for `重命名`, `置顶`/`取消置顶` and
`归档`/`取消归档` only when the actual mutation API exists. Use sibling selection
and menu buttons, never nested buttons; hover, keyboard focus and an open menu
keep the action reachable. Use shared Dropdown/menu items, trailing state cues,
global neutral hover/radius and existing caption/option hierarchy in both themes.
The three-action row menu uses a192px width through shared Dropdown positioning,
with viewport clamping. Do not copy unsupported reference actions or shortcut labels.

Rename uses a source-scoped shared modal with an editable title, trimmed 1–200
character validation and IME-safe submission. Mutation callbacks retain exact
root/session/interaction ownership, lock duplicate writes and show failures
without discarding edits or claiming success. After acknowledgement, sidebar,
header and search reflect the effective custom title; stale live metadata cannot
restore the generated title. Keep drafts, history, reader ownership and runtime
configuration independent of organization preferences.
Track the local management revision captured by asynchronous history reads: only
reads started before a later acknowledgement need that acknowledgement's overlay.
Fresh reads remain authoritative. A save finishing while Settings suspends its
source must not reopen a modal or steal focus, and returning must show the actual
saved title rather than permanently freezing an older acknowledgement.

The archived filter requests `archive:'archived'` from history rather than only
filtering loaded rows. Normal lists request active records and preserve global
pinned-first order across pagination. Archiving the selected record chooses a
remaining active conversation or returns to roles; do not silently reconnect an
archived selection. Restore is available from its row menu and retains saved
content. Archive never stops an existing turn or deletes any record.

Unloaded catalogue rows use the archive's bounded `conversationPreview`, full date/time and actual role/engine context in their hover/focus hint, without hydrating transcript/image bodies. Default entry uses `hasConversation` or actual loaded meaningful message/tool/permission events; `eventCount` alone includes startup diagnostics and cannot select an otherwise empty conversation.

The recovery region separates current connection failure, historical turn outcome, persistence degradation and cleanup ownership. A read-only history state must not imply a second transcript or silently disable drafting. Do not render raw activity/connection JSON entry points. If the only applicable header action is refresh, render a direct refresh control.

When a terminal failure already presents the same connection error for the exact
engine, project, session, generation and turn, show the current offline status
and a recovery action beside the composer. Keep cleanup, model confirmation and
persistence feedback tied to their own states.

Keep earlier-page access and coverage in one compact boundary, visually separate from message prose. Show `加载更早消息` only when `hasEarlier` exposes a real page: use a shared neutral button with an upward arrow, small activity text and subtle horizontal separators. While loading, retain its label/width, replace the arrow with a spinner, expose `aria-busy` and disable repeated clicks. Coverage is metadata, not a second navigation action: do not show `部分历史`, `完整性待确认` or `回合中途` as persistent adjacent labels. A labelled information icon (`历史记录说明`) with `aria-expanded`/`aria-controls` exposes a `hidden` explanation to pointer and keyboard users, including when no earlier page exists. Keep the controls row stable and the explanation in a separate neutral inset row so expansion cannot move the earlier-load action. Partial coverage is `仅能确认部分历史，完整范围未确认`; it can arise from failed capture or uncertain ordering and must not imply successful recovery. Loading another page never guarantees a complete archive. Preserve real paging, source-scoped keys and reading anchors; verify light/dark, narrow, loading and keyboard disclosure states.

Use the [shared feedback mapping](./components.md#feedback-and-recovery) for composer
recovery. Keep recovery actions next to the composer and bounded diagnostics in
the shared disclosure. The model recovery action opens the composer model panel.
An optional connection notice can be dismissed until its state changes. Cleanup
and unconfirmed storage remain visible. The textarea uses the composer's shell
focus treatment.

`ModelSelectionPanel` presents draft, connected and offline states in the same
searchable popup. Draft choices use the loaded catalog. Connected choices use the
current engine's reported capabilities. On an eligible model failure, show the
original session's exact saved candidates and validate the choice with the
existing connection-generation guard. Authentication, cleanup, missing identity,
and concurrent operations constrain the available actions. Plain disconnection
keeps the last confirmed model visible and offers the available connection
action. Draft sending remains a separate user action.

Keep one `FeedbackNotice variant="inline"` at the terminal event of each owned
failed turn. Group matching retries and diagnostics by engine, project, session,
connection generation, turn and cause. Put measured duration, the associated
process and copyable diagnostics behind the failure row. Keep a separate
`处理过程` disclosure where folding would move records past independent visible
events. Preserve the terminal scroll anchor, independent tool failures, unmatched
diagnostics, cancelled outcomes and raw event history.

Completed duration belongs to the actual terminal event's position, ordinarily below its answer. When directly adjacent, target8–12 CSS px from answer to duration and24–32px between complete turns; do not move or conceal intervening tools/observations to enforce that spacing. Legacy/partial pages without reliable turn identity never receive fabricated duration or completion.

Explicit model recovery presents exact saved candidates, with the saved/validation explanation available from an accessible info tooltip. The UI never parses an error's model list, guesses aliases, silently switches providers or offers a replacement conversation as if it were resume. A confirmed model and a successful connection are separate states. Process-stop/cleanup controls appear only from ephemeral backend ownership facts; an error status alone is insufficient.

An actually owned disconnected connection still needs the explicit End action,
including when `cleanupRequired` and `restorePending` are false. Keep the existing
canonical cleanup callback and operation/root/interaction locks; do not launch
automatic stop/retry or hide its failure. Unowned offline history has no process
End action. Verify that this recovery route distinguishes one-shot source-owned
resume, explicit retries and a genuine remount.
Receipt density alone does not establish an automatic reconnect loop.

Inspect actual light/dark/narrow rendered captures, Settings detours, navigation, render identity, callback ownership and progress states. Report fixture/native/vendor/packaged gaps separately. Generic design-system focus failures must not be relabeled as ACP failures; ACP touched inputs require an explicit visible focus ring.

## Composer and result refinements (2026-10-20)

Follow the global selection/hover/result contract in `css-design.md`. Model and
mode menus pass `DropdownItem.selected`; the primitive draws a single trailing
check without a leading empty icon slot. Composer triggers expose a subtle neutral
hover/open surface without layout movement. Recorded file edits and Trellis Hook/
project events use `ActivityResult` with actual title/context and supported view
actions. Editing/failed states never claim “已编辑”; pending work remains pending.
Errors and persistence warnings use a neutral complete frame with semantic icons,
not a colored left border. Preserve the neutral sequential progress connectors.

Default conversation copy is concise: use `说说你的想法…` for the composer
placeholder regardless of connection/busy status. Model menus do not permanently
show procedural recovery text or paragraphs about unsupported reasoning controls.
Knowledge configuration, bridge observations and reference/material actions live
inside the closed-by-default `知识与来源` disclosure, preserving their original
scoped controllers, guards and actionable errors. Source persistence degradation
stays visible as a concise fact in the disclosure header. Do not turn caveats
such as “不强制生成 PRD” into persistent navigation labels.

### Measured composer popup and context geometry

Follow the [shared model panel geometry](./css-design.md#selection-hover-and-result-presentation).

The context ring has a quiet pale base rather than a dark complete ring. Unknown
reports use an unanimated open outline and `上下文用量暂无数据`; actual zero uses a
complete pale outline. Neither has an active arc or a center minus. Positive
reported usage draws only its proportional arc, neutral below75%, amber at75%
and red at90%; these thresholds affect presentation only. Keep exact current-
generation reports and acknowledgement-backed model resets. Verify normal and
threshold colors in both themes in the actual rendered composer.

### Mode labels and compact change records

Translate known native mode names (`Read-only`, `Workspace access`, `Auto review`,
`Full access`) to `只读`, `工作区访问`, `自动审核`, `完全访问`. Case, spaces, hyphens
and underscores do not change a known label's presentation. Submission always
uses the exact original native mode ID; custom names and capabilities remain
untouched.

`compileItems` projects adjacent reliable Trellis file facts into
`{type:'change-group',key:firstEvent.id,events,files:[{path,events}]}`. Only
`spec-updated`, `doc-created` and `material-change` with real path metadata and
compatible project/session/connection/turn/task scope qualify. A non-change event,
an unknown/contradictory scope or an explicit failed/warn/error fact breaks the
run. Never infer a path from prose, assign project watcher changes to the current
Agent or erase source events. Deduplicate file rows using the existing
project-aware path equivalence while retaining every update and its actual count.

The native `details.acp-change-group` is closed by default, with one neutral
`ActivityResult` summary and a compact expanded file list. Keep the first-event
key on appends so updates preserve expansion. Prefer supplied relative display
names while retaining exact path identities. Show only supported view/read
actions; deleted/unreadable material has no fake read action. Warnings/errors
remain outside the fold. Verify projection scopes, ordering, source retention and
real callbacks; inspect default folding, two rows for four updates, append
retention and narrow layout in the actual mounted group.

### Theme-safe menu hierarchy and invitation text

Composer menus inherit the shared caption/option roles from `my-components.css`
and `my-tokens.css`: standard12px tertiary captions versus14px primary options.
Use `DropdownHeader` for plain section captions and `my-menu-header` on the model
navigation header; plus-menu actions and parameter disclosures are choices, not
captions. Keep the back button's24px target while reducing unnecessary leading
padding/gap. Plan mode needs a single clear label and its selected state, without
an inline duplicate “开启计划模式” instruction.

`说说你的想法…` uses the global theme-specific placeholder color. Do not change
entered text color or apply extra local opacity. Shared palette audit, six
theme/font contrast checks and actual composer menu captures must pass when
changing these roles; a light-only screenshot is insufficient theme validation.

### Transcript chrome and reading rhythm

Hide the visible scrollbar only on `.acp-transcript.my-scrollbar` through native
scrollbar-width and its scoped WebKit pseudo element. Keep `overflow-y:auto`,
actual scroll events, source-scoped follow/earlier-page anchors and wheel/keyboard
scrolling; never replace it with `overflow:hidden` or hide every shared scrollbar.
The transcript no longer reserves a scrollbar gutter. Model menus, code/table
scrolling, document readers and the draft textarea retain their own scroll roles.
Check that transcript and composer still share the same centered760px column
through narrow/font/settings and inspector changes.

The global chat role uses13/14/15px across the font presets,1.75 line height and
16px paragraph separation. `--my-txt-chat` is theme-owned (light ink96%, dark
white92%); headings/strong text remain primary. Paragraphs and lists have separate
rhythms, so loose Markdown lists do not inherit a full paragraph gap for every
item. Preserve actual message content and the existing Markdown renderer; do not
rewrite replies or inject headings merely to make a screenshot look structured.

The default transcript has no knowledge setup/editor disclosure. Input plus and
conversation More open `ConversationKnowledgePanel` through the shared Modal;
scope, sources and materials remain available without occupying message flow.
Modal owner is exact root/session and the selected seed identity. Root/session
changes or interaction suspension close the transient panel. History-boundary
keys retain the distinct `history:<root>:<session>` namespace; never reuse peer
keys to accidentally retain orphan DOM. Mounted tests assert zero inline
knowledge disclosures and exactly one explicitly opened owned panel.

`partitionConversationEvents` moves only validated, non-error Trellis file facts
without a matching selected task or real same-session/connection/turn into the
explicit Project Activity view. Preserve original events, unknown/error facts
and actual native tool edits. A filesystem watcher fact does not prove Agent
authorship. Project activity remains readable on demand.

Remove the primary copy-answer editor action. Users request document synthesis,
publication or developer handoff naturally; the same Agent executes scoped tools.
Show compact owned activity and actual source/document links, never artifacts or
progress inferred from prose. Synthesize relevant turns, not one copied answer.
Management editors are secondary. Missing publication-history capability cannot
block scope/read/save; each feature checks its own required methods.

`knowledge-operations.ts` accepts only ACP diagnostic facts with exact project,
session, connection generation and turn plus `activityScope='turn'`. Collapse
repeated facts by this complete identity and operation ID. Hide a duplicate native
tool only when its structured MCP result marker matches an actual owned host
operation; handle direct structuredContent, Codex result wrappers and bounded
JSON text content, not arbitrary model prose/tool names. Unknown tools remain
visible. Source links use the operation's actual persisted IDs; lookup links
must match that turn. Documents may reference earlier supplied sources from the
same conversation, never foreign-session or unsupplied handles. Document links
read the exact returned artifact version. `KnowledgeOperationRow` reuses
the existing source/document readers and shared Modal, with no extra Save step.
Owner changes close transient readers. Pending/failed/uncertain cannot say saved
or published. Preserve native permission prompts and readable failure details.

For host-first lookup, `delivery='preparing'` on the actual accepted user row is
not native delivery. Project only exact-owned `promptDelivery.state` receipts
onto that row: hide the extra label after `sent`, show `not_sent` after pre-send
failure/cancel, and never add a duplicate question or change archived events.
Native tools, model prose and a foreign receipt cannot establish that status.
Actual lookup status/persistence fields distinguish empty, partial, unavailable
and degraded results without opening a configuration form.

Text tabs must use text-sized shared controls; icon-sized `my-segment` controls
cannot hold multi-character labels. Knowledge material body editors retain a
readable multiline height despite shared field min-height specificity. Test
actual computed geometry, default transcript/action count, exact operation/source
provenance, plus/More, background-fact access and unchanged composer draft/focus
in the actual conversation and knowledge controls.

### Role context and connection diagnostics

Role skill pickers select existing project SKILL.md files and persist normalized
relative paths through the profile API. Loading, failed scans, retry and selected
missing files remain usable without clearing the draft. A -> B -> A and suspended
source responses cannot update the active picker. Native skills are inherited;
this selection does not install, disable or isolate the engine's own skills.

The inspector shows only an exact current-generation/current-turn agentContext
receipt. Label prepared, sent and not_sent as transport facts, never loaded,
applied or compliant. Connection timings are a separate collapsed disclosure;
require the current generation and show only measured duration/status fields.
Do not add artificial stage progress or treat a skipped stage as zero-time work.

### Cross-Runtime continuation

Conversation More exposes `用另一个 Runtime 接续` through the shared Modal and
Runtime controls. Apply [the handoff contract](../backend/runtime-handoff.md).
Require an idle, saved source and show an actionable reason when unavailable.
Preview source/checkpoint, target, cwd, editable context and actual omissions.
If `latestTurnIncluded=false`, keep a visible warning and require an edited
current-state summary. State that attachments and tool bodies remain in the
source; users can supply key results and re-add needed images.

Keep the pending operation and context scoped to root/source. Timeouts and
navigation do not mean cancellation: retain the exact operation ID for status
checks/retry. Root, selection, interaction and connection changes fence late
responses. Acknowledged target readiness must remain navigable when the source
is subsequently archived. Prepared and sent are distinct visible states.

Show bidirectional source/target navigation, including archived or unloaded
sources through direct lookup. Opening a source preserves its original history;
another Runtime continuation creates a new branch. Block failed, cancelled or
uncertain targets from silently resuming normal execution; expose status and
owned cancellation/recovery. Keep each conversation's text/image draft on
failed admission, cancellation, A/B switching and background activity. Verify
settled Modal contrast, keyboard focus/Escape and narrow/light/dark layouts.
