# Managed ZCode startup

Read before changing ZCode installation selection, bundled Node, managed native
launching or official plugin asset caching.

## User flow

The user selects the official ZCode installation directory. Resolve and validate
the CLI within that physical directory before saving it. Persist the directory,
not a requirement to locate an internal script. Existing explicit file overrides
remain compatible. Preparation runs automatically; no manual Node installation,
patch application or cache removal is required.

Windows x64 packages include official Node24.12.0 and its license. Packaging
prepares both assets from the pinned release metadata, verifies SHA-256 and
publishes them together. A verified build cache supports offline packaging.
Runtime selection prefers a valid explicit executable, then the verified bundle,
then PATH. Validate independent Node, minimum version and actual SQLite support.
No system PATH or registry changes are part of preparation.

## Native execution

The original ZCode installation stays unchanged. Managed launch reads the chosen
artifact, verifies its exact SHA-256 and unique transformation anchors, and
compiles a bounded in-memory transformation with the original filename, module
paths, main-module identity, argv and workspace. Unknown artifacts execute through
the official path without applying compatibility transformations.

The supported CLI0.16.9 digest is
`97490d0f06a7a225d54d47817acf4b4859cdb268b59f2490caaeda982bef063a`.
Changes to this allowlist require native protocol, persistence and asset evidence.
There is no environment or CLI switch for bypassing artifact verification.

Automatic preparation invokes only the verified native filesystem catalogue.
It must not run the native main command, create a conversation, send a prompt,
authenticate, or write native profile/project files. Preparation success is a
cache fact; session readiness still requires actual storage readiness, the native
create/load response and a validated subscription watermark.

## Asset cache

The host supplies `TRELLIS_ZCODE_STARTUP_CACHE_DIR` under canonical userData at
`acp/runtime-cache/zcode`. Windows callers use `realpathSync.native`; ordinary
realpath can preserve an 8.3 alias. Isolated runs discard inherited cache paths
and use only their explicitly owned temporary cache.

Cache only known official plugin roots inside the selected installation's
resources. User/project plugins and Skills use the native path. Never cache
account material, provider configuration, authorization, permissions or model
selection.

Bind entries to the native CLI digest, physical installation/root, definition,
complete filesystem inventory and metadata. Additions, removals, renames, modes,
time/identity changes and reparse points invalidate a hit. Bounded descriptor
reads verify file identity before and after I/O and recheck the path.

Persisted asset bytes must also match `managed-plugin-assets.json`, a separate
trusted program asset. A manifest's own hashes cannot authenticate its pack.
Verify every path, size, mode and SHA against that independent table. Unknown or
modified asset generations fall back to native scanning. Native per-copy SHA,
locking and atomic seed replacement remain active.

Publish complete packs atomically under disk/memory/file/depth limits. Missing,
corrupt, redirected, contended or unwritable caches retain native behavior.
Readiness markers and diagnostic files never grant execution or establish
conversation persistence.

## Empty conversations

The supported stock CLI accepts `persistence=immediate` but can leave an empty
conversation only in RAM. Managed creation must await the native persistence
operation before producing its creation snapshot. Require a session store and
the native completed-persistence fact; missing/failed/incomplete writes reject
creation. Deferred creation retains its original behavior.

Keep the same native ID and default empty title. Never send a synthetic prompt,
create/clear a goal or add input/history rows to force persistence. Existing
custom/imported titles stay intact; the first real input still follows native
title generation. This correctness transformation is independent of the optional
asset cache for the verified artifact. Unknown artifacts remain unmodified.

## Verification

Run managed Node, installation, startup glue, cache and cache-review groups.
Use the isolated startup matrix with `--managed --fs-probe` to compare native
resource reads with cache-pack reads. Report preparation separately from connect
time; a fresh process/profile does not establish a cold OS filesystem cache.
Verify original artifact digests, native identities, actual terminal results,
permissions and replay behavior after packaging and in the desktop.
