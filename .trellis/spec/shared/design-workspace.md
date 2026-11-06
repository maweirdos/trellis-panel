# Design conversations, canvas and artifacts

## 1. Scope and trigger

Read before changing `design_open`, private design intent, design persistence,
canvas selection, candidate edits, design export or published design playback.
`shared/design-generation.ts`, `design-workspace.ts` and `design-prototype.ts`
own the versioned contracts. This domain uses the existing private Pi runtime;
it does not create an ACP adapter, a second model loop or a team conversation.

## 2. Signatures

The public Pi extension registers:

```ts
design_open({ title, pages, documentId?, baseRevision? })
// pages: { id?, title, html, width, height }[]
// result.details.designOutput:
// { version: 1, documentId, revisionId, manifestPath, title }
```

`window.trellis.designWorkspace` exposes the following main-window operations.
Responses are `DesignResult<T>`; no method accepts an actor, native root, team
source or arbitrary filename as authority.

| Method | Input | Success value |
| --- | --- | --- |
| `list` | none | `{ items: DesignSummary[], incomplete: boolean }` for the authorized local creator |
| `listConversation` | `{ conversationId }` | verified `DesignConversationSummary[]` with candidate IDs and no page HTML |
| `get` | `{ documentId }` | `DesignDocument` |
| `sync` | `{ conversationId }` | imported or revalidated `DesignDocument[]` |
| `createConversation` | `{ kind?: 'web' \| 'app' \| 'prototype', text? }` | private `ConversationRead` |
| `save` | `{ documentId, expectedRevision, commandId, pages?, frames? }` | saved document |
| `send` | `{ documentId, requestId, text, selection? }` | original conversation/request/session/turn receipt |
| `adopt`, `discard` | `{ documentId, candidateId, expectedRevision, commandId }` | resulting document |
| `export` | `{ documentId, format: 'source' \| 'prototype', expectedRevision? }` | `{ cancelled }` |

`DesignSelection` carries `pageId`, `revision`, a bounded selector and optional
`frameId`, `tagName`, `text`, `outerHTML`. It is reference data, never code or
authorization. Every page has exactly one frame with `id`, `pageId`, `x`, `y`,
`width`, `height`.

## 3. Contracts

- `design_open` is permission gated. New output omits both `documentId` and
  `baseRevision`; an update requires both and explicit stable page IDs. If the
  model supplies the all-zero UUID and 64-zero digest together, the tool replaces
  both with a new identity and sets `result.details.placeholderIdentity: true`.
  Supplying only one placeholder fails before writing. IDs are
  case-insensitively unique safe basenames of at most128 characters; Windows
  device names are rejected. Titles are at most200 characters.
- A result has1–8 pages, at most128 KiB UTF-8 per page and512 KiB combined.
  Dimensions are integers240–4096. Validate every page before writing any page.
- The tool creates an immutable `.tpanel-design/<revisionId>/` directory in the
  admitted physical conversation root. It writes exclusive page files and
  publishes `manifest.json` last. Fsync, physical identity and content digest
  must still match after publication. Partial files do not establish success.
- Import requires a completed original Pi `design_open` event with matching
  tool/session/turn/generation proof, manifest and all page files. Replayed
  history does not execute the tool. A renderer-supplied path or title is not
  provenance. Edits update the same document; identical titles can denote
  different documents.
- A design request is proven by the persisted native user message emitted after
  `promptStarted`, the matching completed tool event, and the saved request.
  Match owner, conversation source, project root, session, turn, connection
  generation, request ID and expanded prompt. Missing evidence is retryable and
  must not advance the scan. A new request may create one document; reject an edit
  output that omits or changes its requested document ID or base revision. An old
  output with both identities zero may use its
  immutable `revisionId` as document ID only when its request proves creation.
  Preserve the original manifest and source files. Revisit rejected placeholder
  events once per recovery version and remove a rejection only after registration
  or an idempotent source match.
- Save only history-issued `afterCursor` values for forward scans. Replay the last
  turn while it can still grow; migrate an old reversed cursor when possible and
  otherwise rescan. A scan that exceeds its bounds fails instead of returning a
  partial history as complete.
- Opening a conversation first calls `listConversation`. It validates the local
  creator and each retained document's source, then returns only summary fields,
  page counts and candidate IDs; it must not wait for native history or assemble
  page HTML. The existing `sync` runs independently to discover new output and
  reconcile candidates. A late summary or sync result cannot replace a newer
  conversation owner or completed sync. Missing source proof keeps the verified
  snapshot visible as read-only with an error; `get` loads the full document only
  when the user opens the canvas.
- Library synchronization reports `incomplete: true` when a relevant conversation
  or retained document cannot be checked. Keep verified items visible and offer a
  retry; a failed scan must not appear as a successfully empty library.
- The private local creator owns `userData/design-workspace/`: `documents/`,
  content-addressed `revisions/`, conversation intents, scan cursors and original
  requests. A team account or selected space cannot change this owner. Snapshot
  revisions hash `{ title, pages, frames }`; source records also retain physical
  file identities. Limits are16 candidates,64 history entries,256 source
  records and256 command receipts per document. Reaching a bound preserves
  existing records and reports `E_BUSY`.
- `createConversation` creates an independent Work/Pi draft with a short visible
  prefill. The main process adds design rules only when sending. Store the
  original visible user text separately from the compiled model prompt. Missing
  model configuration must leave the draft recoverable.
- Generated edits merge changed pages into the declared base snapshot as a
  candidate. Adoption requires both current-revision CAS and matching candidate
  base revision. Direct text, source and layout saves create new snapshots.
  Unchanged pages and old snapshots remain intact.
- Retrying a UUID must use its original complete payload. An uncertain send
  retains `requestId`, compiled prompt and source proof; reconcile the original
  native receipt before dispatch. `notSent: true` is distinct from
  `outcomeUnknown: true`. A late success must not clear newer composer input.
- Revalidate the calling main frame, document generation, local creator,
  original conversation and physical root across asynchronous boundaries.
  `get`/`list` can expose retained managed snapshots as read-only when source
  files disappear or change. Successful source revalidation clears that state;
  strict writes remain disabled while the proof is invalid.
- An interrupted first metadata publication may leave exactly two names for one
  complete file: the target and a `.requirement-<UUID>.tmp` in the same physical
  directory. Only the design storage reader may recognize this pair using
  matching file/directory identities and a bounded read. Reads do not unlink.
  Before a subsequent write removes the redundant helper name, validate complete
  UTF-8, the record schema, expected digest and current owner. Reject a target
  matching itself, extra links, external links, symlinks and redirected parents.
  Independent export temps are not recovery candidates. Generated page/source
  readers retain their ordinary no-hardlink rule.
- `assertDesignHtmlSelfContained` uses parse5 and css-tree to check declared
  HTML/CSS dependencies. Require inline styles/scripts, data resources or
  fragment references. Reject external/relative resources, CSS imports,
  unsupported embedded documents/plugins, base URLs and refresh redirects.
  Static checks do not prove arbitrary inline JavaScript safe. The opaque
  `allow-scripts` iframe and `DESIGN_PREVIEW_CSP` remain the execution boundary.
- The iframe has no preload or same-origin grant. Validate exact frame source,
  opaque origin, channel, nonce, document/page/frame/revision and request ID.
  Selection and interaction are separate modes. Parent selection, text edit
  and AI references revalidate the live unique element. A dirty or stale
  revision cannot silently dispatch a retained element reference.
- In canvas selection mode, a trusted wheel event inside the preview sends
  bounded, animation-frame-coalesced coordinates and normalized deltas through
  the same validated iframe channel. The host maps the point through the frame's
  actual scale: ordinary wheel pans, Ctrl/Meta wheel zooms around that point.
  Enable this bridge only when the canvas supplies `onCanvasWheel`; interactive,
  read-only and standalone prototype previews retain their own wheel behavior.
- Track the active page frame separately from a DOM element selection. Starting
  a move or resize retains the pre-gesture frame and draft state. Escape,
  pointer cancellation or lost capture restores that frame without erasing
  pre-existing edits or introducing a false unsaved state. Normal release keeps
  the result. Keep frame-outline width legible independently of canvas zoom.
- Prototype routes use `data-design-page` IDs/unique titles or recognized page
  basenames; back navigation uses the current prototype history. An ambiguous
  title, unknown route or external URL does not navigate the host.
- Source export is a ZIP containing `index.html`, `design.json` and
  `pages/<id>.html`; the manifest includes current frames and page digests.
  Prototype export is a standalone HTML file. Use the native save picker,
  recheck revision after selection, and reject application-data/history targets.
  Exports contain no private creator, native root or conversation proof.
- Publication is explicit through the existing creation draft flow. The fixed
  public body contains a version1 `trellis-design-bundle`; the existing256 KiB
  publication limit applies. Desktop and team Web read this body without private
  filesystem access. Published target anchors include `/<pageId>.html` and a
  selector. Unsupported state/locators remain visibly unresolved. Later private
  edits do not replace a published or adopted task version.
- Ordinary shell surfaces use shared Settings tokens,10px radius,
  `my-item-title`/`my-item-description`, both themes and all three densities.
  Generated page typography follows the user brief. Preserve keyboard movement,
  resize/focus, narrow-window controls and reduced-motion behavior.
- Library covers retain only the first page and route metadata while near the
  viewport. Leaving it releases the iframe and cover bytes; late reads cannot
  restore a hidden preview. Do not retain complete document history per card.

Runtime dependencies are pinned parse5 8.0.0 and css-tree 3.1.0. External Pi
preparation copies their complete runtime closure; source licenses are under
`resources/licenses/design-html/`. Do not rely on the desktop bundle to supply
packages to the independent Node SDK process.

## 4. Validation and error matrix

| Condition | Required behavior |
| --- | --- |
| Invalid page, total size, duplicate ID or declared dependency | reject before generation; no completed design event |
| Tool denied, cancelled, partial write or changed file | retain prior data; no success projection or import |
| One placeholder identity field, or placeholders for an edit | reject; retain generated source and existing document |
| Original request or native user event temporarily unavailable | preserve the scan for retry; do not invent provenance |
| Saved conversation summary is readable while history sync is blocked | show the verified card immediately; continue sync in the background |
| Relevant source scan is incomplete | retain verified library items and show retry; do not report a confirmed empty library |
| Foreign creator, changed root/source or non-main caller | `E_DENIED` or a source-bound failure; no mutation |
| Source missing/archived after successful import | retain current snapshot with `readOnly` and `sourceError` |
| Source restored with original identities/digests | revalidate and permit editing again |
| Stale save/adoption or reused UUID with different payload | `E_CONFLICT`; retain original, candidate and local input |
| Uncertain native send | retain UUID/body and expose `outcomeUnknown`; never invent a new send |
| Invalid/stale element or ambiguous anchor | clear or mark unresolved; ask for a fresh selection |
| Save picker cancelled | `{ cancelled: true }`; no selected file write |
| Revision changes while picker is open | reject export without overwriting destination |
| Public body exceeds256 KiB | show the publication limit; standalone export remains available |

## 5. Good, base and bad cases

- Good: generate blog home/article, select the home heading then its parent,
  reference the heading in the original composer, preview an AI candidate,
  compare it, adopt it, and reopen the same library document. Article bytes and
  old snapshots remain unchanged.
- Base: a proven new-design request with both placeholder fields registers one
  document; reopening and repeated recovery retain the same document identity.
- Base: one requested page creates one page. Reading history or opening a saved
  canvas does not connect a model or start a new turn.
- Base: an existing conversation card appears from `listConversation` before a
  slow history sync completes; opening that card then calls `get` for its pages.
- Bad: a successful-looking Markdown answer, accepted tool start, partial page
  write or unverified path becomes an artifact card; a stale candidate overwrites
  the current draft; switching a space changes private design ownership.

## 6. Required validation

Keep all test programs, mocks, fixtures, screenshots and reports in OS TEMP.
Run root `typecheck`, `check:acpx`, `check:ui`, `build` and affected team-Web
typecheck/build. Verify public SDK extension behavior and external runtime
dependency closure without private SDK imports or a fork.

Assert generation failure has no success manifest/projection, immutable edit
outputs preserve old bytes, source identity survives projection/redaction,
owner/source changes fence writes, same-UUID retries reconcile, interrupted
storage publication can reopen safely, and read-only state can recover. Verify
old rejected placeholder events against the original request and source, including
repeat scans, changed source bytes, wrong turns and a genuine edit request.

Exercise real canvas DOM/parent selection, text save, frame movement/resize,
candidate comparison/adoption, dirty-buffer recovery, theme/density/focus,
prototype navigation/back and library reopening. Check ZIP CRC, exact entries,
page digests and private-data exclusion with an independent ZIP reader. Verify
published annotations and stale iframe replies in the shared reader. State
whether the model provider, native dialogs or browser are simulated; fixture
success does not establish real-model design quality.

For canvas input, verify consecutive wheel deltas accumulate both on the canvas
and inside a selected iframe; Ctrl/Meta zoom retains the pointer anchor. Verify
the same wheel inside an interactive preview does not move the canvas. Exercise
Escape and lost capture with both a clean draft and unrelated unsaved changes.

## 7. Wrong and correct

```ts
// Wrong: title/path from renderer claims generation and current ownership.
registerArtifact({ title, path, root: selectedProject })

// Correct: original private event plus actual immutable source establish proof.
// An all-zero placeholder is new only when its saved request proves creation.
await designWorkspace.sync({ conversationId })
await designWorkspace.adopt({ documentId, candidateId, expectedRevision, commandId })
```

Do not use flowchart nodes, screenshots or imported HTML in the parent DOM as a
substitute for real HTML page frames and isolated element selection.
