# Conversation workflow surface

The desktop conversation embeds a collapsible Trellis panel immediately above
the retained composer. Optional corner docking changes the same component's
placement. It does not create a second workflow tab or transcript store.

## Owned components

- `acp/workflow/use-managed-workflow.ts` owns bounded view subscriptions,
  latest committed snapshots, stable command identities and captured interaction
  lifetimes. The main application owns execution, scope and outcomes.
- `WorkflowCanvas.tsx` uses exact npm `@xyflow/react` 12.12.0 for pan, zoom,
  selection and keyboard interaction. Geometry comes from definition/layout;
  passive runtime updates never fit the canvas or follow another node.
- `WorkflowPanel.tsx` groups stage materials, output versions, original execution
  references and source records. Existing design tokens control appearance.
- `StageHistory.tsx` reads the original history archive by recorded session and
  turn, with the known committed watermark. It is an ephemeral read-only view.
- `model.ts` stores only bounded view preferences and validates material receipts
  against their attributed scope, run, step and attempt before presenting them.

## Interaction and source contracts

All commands use `window.trellis.managedWorkflow` with the expected project root.
The root is an anti-retargeting precondition; it is never an authorization grant.
The main process resolves real task/engine/control ownership. The panel renders
actual backend snapshots and receipts. A definition edge remains a planned
dependency unless an applicable real handoff record exists. Graph geometry and
counting visible stages do not establish task or Jira completion.

Prepared, assembled and emitted-to-host material receipts are distinct. Source
and included digests distinguish full content from an excerpt or unconfirmed
body delivery. These facts do not prove native tool reads, model understanding
or compliance. Unknown internal child-agent activity remains explicit.

Material actions pass the recorded ref and node's actual run revision through
the authorized artifact API. The returned fixed token opens the existing native
reader; it does not reopen a mutable disk path as a substitute for that version.
The existing reader owns comparison, pinning and return to the original chat.

Stage-history reading uses returned opaque `before` cursors, scans at most eight
pages per action and filters the original exact `sessionId`/`turnId` and available
committed `historySeq`. Newer turns in a reused session are excluded. Coverage,
missing records and display bounds remain visible; a latest turn is never used
as a fallback. Matching records reuse existing timeline/Markdown components.
Historical permission rows cannot recreate actionable permission choices.

Live permission cards refer to actual stage snapshots and exact request/option
IDs through the existing broker. A stage that differs from the selected origin
can therefore request human input. When that stage is itself selected, its
ordinary live permission presentation handles the same request without a second
workflow card. No approval option or permission policy is fabricated.

During known managed/recovery ownership the original composer remains mounted
and read-only, preserving its draft and selection. The ordinary send callback
also checks ownership. The current boundary-feedback adapter is unavailable;
the UI says so and never sends an apparent feedback message as a competing
ordinary native turn. Existing ordinary conversation behavior remains available
outside managed ownership. Main-process guards remain authoritative on races.

View preferences are bounded to forty root/task keys under
`tpanel.workflow.views`. Collapsing, docking, selecting another task or opening
history preserves the relevant viewport/selection. Only explicit Locate Current
or zoom/pan actions move the graph. Passive snapshots cannot focus the composer,
clear a draft or reset a reading position. Interaction lifetimes reject async
completions after source/generation changes, including away-and-back transitions.

## Verification and limits

`node scripts/smoke/workflow-conversation-render.mjs --report <path>
--capture-dir <directory>` mounts the actual React components/controller/React Flow
in an isolated Electron Chromium window. It covers dense projected updates,
native request identity routing, exact-turn history paging, selected artifact
tokens, snapshot/admission failures, stale owners/revisions, subscription renewal,
keyboard/Escape, docking, task preferences, 1280/1440/1920/720/420 widths and175%
browser zoom. Hidden fixture frames are explicitly pumped for actual layout.

Backend/native calls in that script are controlled fixtures. They establish
renderer behavior, not a real model run, Jira flow, packaged OS stacking or full
source-scenario acceptance. Main must complete the real controller/driver UI
chain and native acceptance. The existing synthetic `acp-ui.mjs` suite requires
explicit workflow component/controller boundary mocks; it must not fake React
Flow rendering by expanding its minimal React implementation.

Run repository typecheck/build, shared UI checks and the relevant existing
conversation regressions after integration. There is no configured lint script.

## Independent integration review additions

Control cursor order applies across run IDs and same-revision state updates; a reset
clears the bounded live event window and exposes a gap. Retired epoch snapshots
cannot replace the current projection within the bounded recent-epoch window.
Queued, stopped and failed heads identify their actual stage rather than a later
planned stage.

Stage permission cards require the exact nonempty native connection generation,
session, pending request and offered option. Async replies belong to the captured
interaction lifetime; switching away and back cannot revive an old error. No
permission is granted automatically and historical choices remain read-only.

A committed fixed-history view excludes rows without a sequence when its commit
watermark is known, and discloses that exclusion. Combined continuation limits
(count and text bytes) are disclosed, not reported as complete coverage. Opaque
native cursors remain authoritative. Exact run/session/turn/commit and material
references remain available in expandable source details; primary labels explain
what the user is viewing instead of presenting internal IDs by default.

Mutable ordinary sends and new managed starts are additionally arbitrated in the
main process by canonical physical workspace. Ordinary end/cancel remains usable
for draining a turn; read-only browsing does not claim execution. Persistent
per-worktree discovery references point to existing authoritative control stores;
they are not another execution owner database. See the task admission protocol
handoff for source APIs, restart/legacy limitations and remaining acceptance gates.


Main admission now also uses the actual ACP owned-session scalar inventory across
project roots. Native new/resume/model-recovery/config IPC calls join the same
physical-workspace token as prompts, so initialization or load cannot race behind
managed-start inventory. End/cancel still drains; history browsing stays read-only.
Connection admission does not delay quit from reaching actual native shutdown;
occupancy remains fenced until pending lifecycle and actual native ownership end.
