# Creations and bounded development references

Read before changing personal/team creation, webpage opinions, candidate modification, task adoption or generated native development materials.

## Contracts and ownership

- `shared/creations.ts` owns the validated wire/persistence schemas; `creations-domain.ts` owns permissions, immutable publications, review continuity, candidates and adoption rules.
- `creation-api.ts` exposes the source-bound desktop/browser interface. Renderer inputs carry a workspace key, never credentials, native roots or an asserted actor. The adapter derives identity, membership and epoch before and after asynchronous reads.
- Published bodies, drafts and candidates stay outside `HifoxSnapshot`. Lists contain authorized metadata; opening a revision loads one body. `creations/head` hashes authorized identity/revision metadata for change detection without loading HTML. Browser/native observers notify only actual changes, with bounded polling and cleanup.
- The existing team SQL writer owns shared persistence, CAS, receipts and additive migrations. Desktop local mode uses the same pure domain and atomically stores its record with bounded command receipts. Unknown shared writes retain the original source, epoch, UUID and payload; recovery rechecks or repeats that same command.
- Pending records missing their original project proof remain preserved and locked; never infer a destination from the current selection. Shutdown belongs to confirmed quit cleanup, after the reversible quit confirmation.
- Personal creations belong to the selected collaboration source. Personal drafts and private notes remain owner-only; publishing shares a fixed revision. Team draft editing uses explicit same-space editor grants. Occupation names do not grant permissions.

## Lifecycle

Publication and adoption never schedule a business version or move a task workflow. Existing task/version commands retain that authority. A task can reference several creations; a creation can serve several tasks.

An adoption records the exact publication digest, review watermark, confirmed rules and their frozen targets. Later publication does not replace it. Explicit later adoption is a new source revision requiring native material review. Unresolved required opinions from earlier publications cannot be bypassed by publishing a new revision. Confirmation records the displayed review revision; AI candidate application never confirms an opinion.

## Webpage preview

`PrototypePreview` hosts self-contained HTML in an opaque `allow-scripts` sandbox. Its first CSP forbids network, external frames, workers, forms, base URL changes and privileged capabilities. Never render imported HTML into the parent DOM or grant same-origin access.

The child protocol validates exact frame source, opaque origin, per-document nonce, action and bounded data. It transmits DOM facts, not executable commands. Supported capture includes elements and text; coordinates are a fallback. Restoring page state is best effort. Text field restoration requires `data-preview-state="true"`; sensitive fields are excluded. Missing or ambiguous targets stay visibly unresolved. Arbitrary external sites, drag-region annotation and arbitrary application-state replay are not supported by this adapter.

## Context budgets

- Implicit ACP materials use a path-only index within 8192 UTF-8 bytes. Explicit references share another 16384 bytes. Headers, read-more notices and framing count toward those limits. Preserve source revisions and contiguous UTF-16 extents for included text.
- Generated native PRD is at most 6144 UTF-8 bytes. Complete original text goes to `references/source-materials.json`. Adopted HTML and frozen rule/scenario files are separate read-on-demand files; they never become automatic conversation attachments.
- Prototype modification sends selected source windows and at most eight opinions within a 12288-byte input envelope. It uses the configured model and returns exact replacements. Reject unknown, repeated, ambiguous or stale matches. Cancellation prevents candidate admission; an already admitted save must be reconciled.
- Token values are estimates. These budgets do not claim to bound user messages, model tool reads, unrelated knowledge retrieval or the whole session.

## Native handoff

The existing `HifoxTaskWorkspaceService` creates or reuses the original native execution identity when an authorized handler starts code work. Parent composition injects creation reference/body resolvers; the core service stays independently testable.

Validate source/epoch, fixed digests, native roots and task-relative paths before writing references. Save generated files with CAS, retain their digests and reject modified/deleted references on reopening. Existing human PRD edits are never overwritten. General non-code work does not require Trellis.

## Validation

`npm run check:creations` covers native persistence/recovery and bounded candidates, native material transfer, sandbox selection protocol, and isolated renderer ownership flows. Team-service creation tests cover authenticated ACL, metadata projection, CAS, epoch changes, publication/review/adoption, change detection, migration and restoration. Browser adapter tests cover the real wire schemas, owner changes, retained commands and metadata-only refresh. Native/browser fixture evidence does not certify a real model's output quality or physical multi-computer deployment.
