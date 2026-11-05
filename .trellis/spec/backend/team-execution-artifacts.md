# Execution artifacts and handoff checkpoints

## 1. Scope / Trigger

Use for fixed general execution outputs, delivery manifests, handoff checkpoints,
predecessor resource consumption and owned local code verification. Reuse the
existing team service, task/material/creation authority and immutable blob store.
Formal PRD/design/implementation/delivery-note approval keeps its existing rules.
Native admission, engine launch and UI integration retain their separate owners.

## 2. Signatures

`src/shared/team-execution-artifacts.ts` owns artifact, output-reference, manifest,
checkpoint and code-source schemas. Original task identity, actor/device,
epoch/generation and command UUID follow execution contract version 2.

Commands use the existing
`/api/projects/:projectId/hifox/tasks/:taskId/executions/commands` and `/reconcile`.

| New command | Payload |
| --- | --- |
| `save-artifact` | `artifactId`, nullable `previousVersionId`, `artifactKind`, `title`, exact UTF-8 `text`, `expectedDigest`, `disposition:draft|confirmed`. |
| `seal-delivery` | Nullable exact `previous` version/digest and up to 16 `{outputId,ref,carriedFrom?}` entries. |
| `checkpoint` | Nullable exact `previous`, exact `manifest`, bounded `remainingWork`, selected code `source` and nullable native `observation`. |

Fresh artifact/delivery/checkpoint commands pin the original node and attempt as
well as execution generation. Historical duplicate/reconcile reads retain the
original command scope rather than requiring the current producer node.
The new kinds require `expectedNodeId` and `expectedAttempt`. An optional bounded
`nodeAttempts` ledger records visited node attempt heads without defaulting old
rows. Re-entry requires the next attempt; A1 → B1 → A1 cannot revive queued A1
writes. A1 → B1 → A2 is a new producer boundary.

`finalize.finalization` keeps its original outputs and accepts optional exact
manifest/checkpoint references. Execution records add optional `artifacts`,
`deliveries` and `checkpoints`; retained rows receive no default arrays.
Relations remain in the existing execution record, with bodies in existing
blobs. No new body store or database migration is introduced.

`GET .../executions/:executionId/artifacts/:versionId` with the existing version-2
task query returns fixed metadata and text under current task ACL.
`TaskExecutionTransport.artifact(ref)` validates original scope, disposition,
digest and UTF-8 bytes. Fixed T03 sources accept confirmed artifacts and
supported published HTML through exact predecessor finalization references.

Main-only local ports in `hifox/task-outputs/handoff-source.ts`:

```text
captureSelectedFile({root,relativePath,expectedDigest?,assertOwned})
captureGitPatch({root,repositoryId,base,expectedDigest?,expectedWorkcopy?,assertOwned})
verifyHandoffSource({root?,source,role?,requiredCode?,expectedWorkcopy?,
  targetPaths?,readArtifact,assertOwned})
```

## 3. Contracts

- `confirmed` means the server received and verified fixed bytes/reference. It
  grants no document approval, passing test result or business acceptance.
- Artifact versions bind original task/execution/generation/node/attempt.
  Confirmed versions remain immutable. Stale version comparison retains a
  conflict candidate without replacing the current non-conflict head.
- Use existing receipt UUID/canonical payload checks through acknowledgement
  loss. Canonicalization must match actual JSON representation, including
  omitted optional undefined object fields. Retained valid JSON hashes remain
  unchanged.
- A delivery pins exact output refs. Draft, conflict, missing, unapproved and
  wrong-scope sources cannot satisfy required output declarations. Formal
  document output kinds resolve actual approved versions; report text cannot
  impersonate a design/PRD approval.
- Produced entries satisfy only their original current producer's declared
  output policy. Carried entries explicitly name an existing sealed node
  delivery or the declared predecessor's completed finalization. They preserve
  original producer/version and never substitute for current required work.
- Predecessor carry may include older original refs already carried through the
  immediate predecessor. T03 admission checks exact membership in that fixed
  predecessor finalization, not a copied body or mutable latest head.
- Completed fresh managed delivery requires an exact manifest and checkpoint;
  final outputs match the manifest's complete ordered reference set. Validate
  every reference again at ordinary business handoff.
- Already committed pre-upgrade formal-document finalizations keep their
  retained contract. Fresh-finalize admission and retained-finalization checks
  are distinct; an upgrade cannot strand an old completed execution.
- Ordinary transition paths, including generic business commands, verify
  original execution/output/boundary refs and recipient access before committing
  task changes and old-writer revocation in the same owned transaction.
  Emergency reassignment/cancel preserves its existing domain authority and
  unknown native/process facts.
- Current task/resource ACL applies to peer reads and old receipt recovery.
  Recipient ACL projection is server-internal and derives a real active person;
  it is never a wire actor override or new credential grant.
- Supported creation outputs resolve exact published same-project/same-space
  team HTML revisions through the existing creation reader. Personal drafts,
  wrong-space sources and unsupported formats reject. A newer unrelated draft
  cannot hide or replace an original approved/published output version.
- A checkpoint contains only selected fixed outputs, bounded remaining work and
  explicit code source. It neither exports private conversations nor uploads an
  entire workspace. Git commit refs contain actual full object IDs; a branch
  name or free-text completion claim proves no code availability.
- Code source `none` makes no code claim; `requiredCode:true` rejects it.
  Selected files work in ordinary directories without Git. Local verification
  distinguishes available bytes/patch from actual application; only the latter
  can establish selected code readiness. T05 still owns native admission.
- Non-none checkpoint observations require the original authenticated device
  and are labeled `device-reported`. The server confirms artifact bytes, not
  another device's filesystem. Receivers verify their own selected target.
- Capture exact UTF-8 including BOM, with bounded descriptor reads and physical
  root/component/file revalidation. Reject links, hardlinks, traversal and torn
  or changed source. Pin caller inputs and ownership/read callbacks before
  asynchronous work; callbacks cannot change the expected reference identity.
- Git verification is read-only for original worktree/index/objects. Verify
  actual base/commit objects, selected working bytes, original control roots and
  unpublished changes. Preserve safe built-in Git normalization and reject
  external filters/hooks/unsupported histories. Cached clean status alone is
  not evidence that actual bytes match the selected code.
  Rebuild a private OS-TEMP index from original bounded stage-0 entries with
  zero stat data, then force content comparison through it. Preserve Git's
  built-in normalization and keep original index bytes unchanged. No repository
  object or working-file write is permitted. Temporary-index cleanup stays
  inside the verified owned TEMP directory.
  Graft files and external graft/shallow history overrides are unsupported.
- Linked worktrees use the existing workcopy identity owner. Verify the actual
  shared registry, backlink and common-dir references before/after observation.
  User-supplied native paths/callbacks never become renderer capabilities.
- Bounds remain explicit: 1 MiB per selected UTF-8 file, 128 KiB patch, 2048
  tracked entries and 16 MiB native tracked bytes. Artifact/manifests/checkpoint
  histories are bounded, and serialized record/read limits must retain recovery
  of original commands.

## 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Same UUID, changed payload/target | Conflict; retain original committed intent. |
| Stale artifact predecessor | Retained conflict version; no head overwrite or handoff satisfaction. |
| Missing/draft/conflict/wrong-scope required ref | Reject manifest/finalization/handoff. |
| Wrong output kind for formal document | Reject; preserve original approval authority. |
| Carried ref outside sealed source/predecessor | Reject; no implicit transitive permission. |
| Carried output offered as fresh required work | Reject producer mismatch. |
| New completed managed delivery missing exact checkpoint | Reject; no old-writer revocation. |
| Retained old completed finalization lacks T04 fields | Preserve valid original transition/recovery behavior. |
| Recipient cannot read an original required source | Reject ordinary handoff before business writes. |
| Old writer reports after handoff | Reject fresh mutation; authorized original receipt recovery remains. |
| Non-device native observation | Reject `device-reported` claim. |
| Code missing, unpublished or only named by branch | Reject readiness/continuation. |
| Patch available but not applied | Return `available-not-applied`, `ready:false`. |
| Directory/file/callback changes across awaits | Reject or retain the original pinned selection; never retarget. |
| Git cache reports clean while actual bytes differ | Reject readiness or include actual changes in selected patch. |
| Producer node/attempt changed after enqueue | `EXECUTION_PRODUCER_CONFLICT`; no new artifact/manifest/checkpoint. |
| Node re-entry reuses an old attempt | Reject; original duplicate UUID recovery does not mutate current producer. |

## 5. Good / Base / Bad Cases

Good: implementation publishes a fixed report and selected code. Checking reads
those original versions, adds its own report and explicitly carries the original
refs to the next execution. Peers read permitted versions while the producer is
offline; later drafts do not replace the delivered facts.

Base: an ordinary document task creates a no-code checkpoint without Git or a
native root, while existing formal-document approvals remain unchanged.

Bad: call queued upload confirmed, relabel an earlier node's result as current
work, assume a patch was applied because its bytes exist, or pass handoff with
unpublished required code and a false clean Git cache.

## 6. Verification

Keep all validation programs, repositories, fixtures, accounts, stores and
reports in OS TEMP. Run applicable root/service typechecks/builds and existing
production guards; no tracked test dependencies or CI are added.

Use real HTTP/SQLite with two authorized members for fixed reads, conflict
retention, exact required refs, approval/new-draft distinction, recipient ACL,
atomic ordinary transitions, forced ownership changes and old UUID recovery.
Verify real pre-upgrade active/completed data and three-execution carry without
copying producer identities. Exercise exact native file capture, linked Git
worktrees, safe normalization, false stat caches, root/callback/ref changes,
source versus receiver application and all quotas. Native launch, provider
execution and UI acceptance remain separate.

## 7. Wrong vs Correct

Wrong: upload an implementation report and mark the task accepted because a
branch exists on the original developer's machine.

Correct: pin confirmed output versions, keep human approval/testing authority,
record the actual selected code and remaining work, revalidate the recipient
and transition boundary, then revoke the former writer atomically.
