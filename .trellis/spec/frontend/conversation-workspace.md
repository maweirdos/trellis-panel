# Conversation, document and appearance contracts

## Named roles and execution engines

Profiles are named local project-scoped assistant roles; Codex/Claude Code are execution engines beneath them. New Conversation must open a role chooser and start only after an explicit action. Install in the relevant panel, refresh from actual returned runtime state, and distinguish installed-awaiting-connection from missing installation. Model controls consume actual connected-session capabilities and acknowledged configuration; the current profile DTO has no persisted default model. Do not simulate team sharing or per-role tool/knowledge/skill binding. Keep current session snapshots separate from edits to defaults for future sessions. Consume the application sidebar width/resize component, including collapsed/mobile reopen behavior.

### Conversation continuity and compact controls

Opening a selected resumable history connects it once, with history/drafts visible while connecting. No manual restore landing page, prompt replay, replacement conversation, automatic retry loop or hidden Settings-source reconnect. Explicit Stop must not immediately reconnect from a status update. Legacy transcript-only records remain clearly read-only. Failed native load offers an inline retry and preserves raw details; external locks/provider restrictions are not bypassed.

The composer hosts native mode, collaboration, model, reasoning and remaining advertised configuration through anchored shared Dropdowns. Prefer a unique advertised category=model/mode config option when session/set_config_option is supported; fall back to legacy controls only when advertised. Use one local configuration lock and apply choices only after acknowledgement. A reasoning track contains exactly the engine's returned options, never invented strengths, permission presets or default reset. Remove duplicate current-session forms/select autofocus from the inspector; retain environment context and a return-to-composer action. Internal menu scrolling must not dismiss the shared Dropdown. Do not restore below-composer task/keyboard hint rows; retain actual task entry and IME-safe submission.

Tools/thoughts/startup/activity use compact icon+label+one chevron rows with details behind explicit expansion. Do not insert successful turn-end separators or giant bordered activity boxes. Request failure details remain accessible. A completed response does not remove the input or disable a live connection.

RunActivity is secondary to the answer: use the shared small font/tertiary label color (default12px versus answer14px), 14px icons in16px slots, 12px chevrons, consistent stroke and24px rows. Completed turns default to a muted duration disclosure; running labels describe the actual current action with a spinner. Explicit user expansion is respected. Expanding the first level directly shows readable observations/metadata and thought/tool details, never answers, errors or actionable permissions. Remove a sparse intermediate response-record accordion. Secondary styling must not omit readable content: preserve configuration/session/command/usage reports, actual values when available, and update counts for repetitions. Show real latency once. Use a neutral node for informational updates, not a fabricated completed step; full raw records remain opt-in after the readable content. No arrow for an empty disclosure. Legacy records without reliable turn identity are not silently regrouped. A thin semantic border separates the first answer block from processing.

Running headers show actual elapsed time with a visible current-step spinner; terminal completion/duration requires an actual turn-done event. Busy/permission/cancel/tool/thought/reply labels use matching live facts, never another turn. Raw JSON is separately requested and lazily rendered; it cannot substitute for readable status content. The subtle vertical rail connects actual nodes only; a single node has no dangling rail. Suspend the timer for hidden retained sources and honor reduced-motion. Actual setup observations may be shown as context for the first real turn of that exact connection only, without generating a new transcript entry or reassigning their original identity. Do not duplicate the same startup facts in a top-level startup panel and the timeline group.

Latest user override: do not render raw activity/connection JSON entry points. Usage_update is not an activity step; ComposerUsageIndicator sits immediately before model selection and shows actual context occupancy in a static ring with hover/focus details. Use only the current connection's reports, clear stale values on acknowledged model changes, preserve unknown as unknown, and never infer model capacity or sum updates. Other readable process/tool/thought content is retained.

The connected rail represents sequential current-turn stages only, via projectRunProgress. A start is not completion: admission starts sending; prompt-written starts waiting; actual model content starts generating; terminal completion finishes the current stage. Show only reached stages and exactly one current stage; unknown history, failure and cancellation cannot appear checked. Metadata and empty thoughts cannot advance the rail. Connection preparation occurred before sending: retain it in a separate collapsed summary explicitly labeled as such, never intermixed into the current-turn rail. Informational updates remain readable outside the rail without pending/completed icons. Do not animate/replay stored milestones to simulate execution.

Latest compact-presentation refinement: constant sync/available-command notifications do not occupy the transcript (retain stored facts). Prior connection context uses a concise confirmed-ready summary with real duration and a neutral historical timeline on expansion. Do not change the working sequential rail. Only the active thought segment includes a bounded, rolling preview revealing already-received characters; hide that line on reply/tool/plan output or turn end, and never show it for history. Full thought content remains expandable. Stop presentation timers after catch-up, when hidden/open, and on unmount; reduced-motion skips typing.

Keep the default composer to plus/current mode at left and usage/combined model+reasoning/send at right. Existing task/machine context, actual advertised plan/collaboration choices and other parameters move into plus. No reference-only attachments, plugins or fictional plan mode. An active plan may have a small acknowledgement-backed badge, avoiding duplicate labels. The one model dropdown contains native model choices and the native reasoning selector. Exact original IDs, shared configure lock and runtime acknowledgement are unchanged.

The non-actionable local-execution row is omitted from plus. Binary native default/plan choices become one on/off action, not separate choices/group titles. Turn off only to a known actual counterpart/prior native mode; never guess a permission policy. The unified model popup defaults to compact strength settings; clicking the model caption switches to the model list, with back and acknowledgement-backed return to settings. Dropdown layoutKey repositions changing views/widths while retaining menu ownership. Use a16px rail,20px visual thumb/24px hit area and3px dots rather than the earlier thick strength bar; option names remain in title/ARIA.


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

Use shared Button/Dropdown/Modal/Escape layers and `my.*` tokens. Standard Button forwards accessible/data attributes. Font controls exist **only in Settings**, never the home/conversation top bar. Small defaults to UI/chat/document 13/14/15px; standard 14/15/16px; large 15/16/17px. Consumers use `--my-text-ui/chat/document`, line-height and control/row/header/avatar variables. Shared inputs consume the UI font variable; multiline inputs explicitly override single-line height.

Recent rows are single-line titles (small32px). After about350ms hover/focus, show a small viewport-clamped hint with existing title/description/context; do not activate the conversation. Attach `aria-describedby` while visible. Escape, scrolling, navigation and scope changes dismiss it. No persistent description/metadata rows.

The hint summarizes the coherent latest message/response, not the last streamed token event. Assemble only compatible role/turn/session/connection chunks, exclude thought/tool/diagnostic text and older turns, then normalize whitespace and apply the display bound. Verify with actual fragmented streaming records; a single static message test cannot catch a one-word summary.

A diagnostic event is not automatically an error. The structured adapter-native capability fact (`toolExecution='adapter-native'`, client filesystem/terminal callbacks both false) is neutral, collapsed runtime detail with original text/raw payload inspectable. Explicit warning/error/auth codes and failed tools take precedence and remain visible. Do not hide unknown diagnostics or use a text-only match to suppress a failure.

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
| Missing/invalid appearance | Small; retain unrelated/legacy preferences |
| Font change | Tokens update, draft/reader/runtime identity retained |
| Stale/empty diagnostic active ID | Useful library entry, secondary history preserved |
| Root/session/generation drift | Reject stale callbacks/refs, preserve scoped draft |
| A reference with disk B | Main rejects before turn; explicit compare/read/re-reference |
| Nested same-name planning file | Cannot satisfy principal review |
| File deletion/read failure | Honest diagnostics, no successful blank replacement |
| Hover/focus without click | Hint only; no session/start/send |
| Topmost hint/menu/diff + Escape | Close that layer only |
| CRLF/LF/CR Markdown with headings | Same outline, stable IDs/line numbers and version-bound section quotation |

## 5. Good / Base / Bad Cases

Good: A displayed, B pending, font/expand changes retain A and draft. Base: unbound discovery requires explicit idle task association. Bad: a nested research PRD counts as principal review, or restore silently updates an old authorization reference.

## 6. Tests Required

`acp-ui.mjs` covers real controller/IME/draft/follow/permission/root/restore, view migration, hover, principal review and explicit recovery/intents. `acp-document-reader.mjs` uses actual hooks/deferred IPC/reader slices for multiowner/race/path/provenance/release behavior. `acp-document-pane.mjs` exercises real pane outline/loading/navigation/focus/section-quote handlers with CRLF input; reading-session tests require line-ending parity in the shared parser. Retain reader-wiring/task-reader/task-presentation tests. `navigation.mjs` tests actual appearance persistence/legacy/storage/root boundaries. Run typecheck/build, generated class gate and actual light/dark/narrow/focus/IME; synthetic results do not close native/vendor gates.

## 7. Wrong vs Correct

Wrong: transplant demo state/palette/Markdown, add a font switch to the conversation header, or equate basename/read facts with approval.

Correct: compose production shared components/controllers/readers, change semantic tokens from Settings, capture exact current source/target refs and preserve workflow authority.
