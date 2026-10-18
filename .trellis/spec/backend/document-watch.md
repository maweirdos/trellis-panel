# Exact document watch ownership

## 1. Scope / Trigger

Read before modern watch bridge/IPC/preload/reader-cleanup changes. Canonical path alone is insufficient after A→B→A or concurrent hosts.

## 2. Signatures

```ts
api.documentWatch(scope, { relativePath, knownRevision })
// success: {ok:true, watchId, canonicalPath, relativePath}
api.documentUnwatch(canonicalPath, watchId?)
watchReaderDocument(root, scope, input, authority?)
unwatchReaderDocument(canonicalPath, watchId?, authority?)
```

Main authority is `{projectRoot,projectGeneration,ownerId}` from actual current root/generation and `event.sender.id`. Scope workspaceId/taskRef is namespace/echo, not authorization.

## 3. Contracts

Every registration has a distinct opaque watchId. Release requires exact live token/path/root/generation/window owner. Duplicate/unknown/stale/foreign releases are no-ops. Project clear invalidates all tokens; sender destruction removes that sender's registrations. Settled timers validate exact entry identity before publishing, not path lookup alone.

The optional second argument retains call compatibility, **not path-only authority**: omitted tokens fail closed. Older clients receive updates until normal project/window cleanup but cannot release newer owners. Internal readers pass returned tokens, including late-ack cleanup, with locally idempotent release; missing tokens never fall back to path. Actual add/change/unlink reaches the modern bridge; deletion is unavailable revision, not a new blank body.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Missing root/unauthorized watch path | Structured request failure, no lease |
| Two hosts, same file | Distinct tokens; closing one preserves the other |
| Old A ack after clear/new A | Old cleanup cannot release the new registration |
| Legacy path-only/duplicate/foreign release | No decrement of another owner |
| Window destroyed/project cleared | Exact owner/all obsolete leases removed |
| Old settled timer after replacement | No publication into replacement entry |

## 5. Good / Base / Bad Cases

Good: TaskDetail closes while ACP keeps its baseline/lease. Base: one host releases its token once. Bad: a late `unwatch(path)` from old A stops new A updates.

## 6. Tests Required

`document-watch-ownership.mjs`: actual IPC root/generation/sender/duplicate/clear/destroy boundaries. `reader-wiring.mjs`: real bridge tokens/path-only no-op/filesystem changes. `acp-document-reader.mjs`: actual hook late acknowledgments, clear/new owner, duplicate cleanup and independent hosts. Keep native file/update evidence separate.

## 7. Wrong vs Correct

Wrong: release by path or let a stale timer act on the current entry found by path.

Correct: retain `{canonicalPath,watchId}` for each registration and release that capability once; main validates trusted authority independently.
