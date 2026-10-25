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

Installation selection's `prepareBundledZcodeStartup` invokes only the verified
native filesystem catalogue.
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
Verify every path, size, mode and SHA against that independent table. Runtime
catalogue hits may validate metadata and the physical pack's identity/length
without loading its payload. Read only the requested asset range, with guarded
descriptor/path checks, and verify its bytes against the independent pinned SHA
before returning them. Keep verified bytes private and return copies under the
memory quota. Source and pack replacement/race checks still apply to later reads.
Eager installation preparation and cache-miss publication retain complete pack
verification. Unknown or modified source generations fall back to native
scanning. Native per-copy SHA, locking and atomic seed replacement remain active.

Publish complete packs atomically under disk/memory/file/depth limits. Missing,
corrupt, redirected, contended or unwritable caches retain native behavior.
Readiness markers and diagnostic files never grant execution or establish
conversation persistence.

Choose the final cache-enabled or correctness-only transformation before
compiling the native source. A successful cache-enabled transform must not first
build and discard a correctness-only copy. Preserve full artifact/anchor checks,
and retain the correctness fallback when optional cache preparation is unavailable.

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

## Windows Codegraph command hooks

The verified artifact's `ebo` command callback selects only `command.shell`
when all of these conditions hold:

```js
process.platform === 'win32' &&
n.shell === undefined &&
(
  (t === Tl.SessionStart && /^bash\s+(["'])\$HOME\/\.zcode\/hooks\/codegraph-(sync|context)\.sh\1$(?![\s\S])/.test(n.command)) ||
  (t === Tl.UserPromptSubmit && /^bash\s+(["'])\$HOME\/\.zcode\/hooks\/codegraph-nudge\.sh\1$(?![\s\S])/.test(n.command))
)
```

Resolve with native `hoe({env:process.env, platform:process.platform})`. Use
`provider.file` only when its dialect is `git-bash` and its file is a nonempty
string. Missing, non-Git, invalid or throwing resolution retains `n.shell`.
The native execution adapter initializes `Hln` through `Yjr`, `Zjr`, `Kjr` and
`cat` before constructing the port supplied to hooks; the hook helper must not
run bootstrap initializers.
Require the complete pinned CLI SHA and unique original `ebo`, `hoe` and `txs`
anchors before transforming. Keep this correctness correction active with either
`cache:false` or `cache:true`; preparation runs only the filesystem catalogue,
without executing hooks or installing the hook correction in its entry point.

Native `txs` accepts a string shell unchanged. The execution port keeps generic
shell execution through the selected Git Bash with `-c`, without a login shell
or a shell-init snapshot. Do not add `shellProfile:'posix-bash'`: that profile
also enables `ShellInitSnapshotManager`, whose initialization can wait on startup
files and snapshots independently of hook runtime. On Windows, `hoe` checks
native Git Bash installation candidates, then paths inferred from PATH's
`git.exe`. Leave PATH, HOME, provider configuration and `shellOverride` unchanged.

Preserve the original shell mode, command text, explicit shell, executionPort and
permission flow, cwd, environment, JSON stdin, resolved timeout, output limits,
trace, abort signal, result interpretation and awaited stdin cleanup. Never skip
the script, synthesize success or cache hook output. User scripts and hook
configuration remain unchanged.

Every event/command pair outside this allowlist retains its original request:
PostToolUse sync, UserPromptSubmit sync/context, SessionStart nudge, and
PreToolUse/PermissionRequest gate/nudge remain unchanged. Project Python workflow
hooks, explicit shells, unknown commands, different paths, added arguments,
shell suffixes and trailing newlines remain unchanged. Non-Windows execution and
unsupported artifacts retain native behavior.

## Verification

Run managed Node, installation, startup glue, cache and cache-review groups.
Run `node scripts/check-agent-runtime.mjs --only=zcode-windows-hook-shell` for
the native `ebo` VM fixture: compare requests apart from the admitted shell,
including both quotes, resolved timeouts, the exact event/command pair matrix,
explicit shells, resolver failure/fallback, stdin/env/signal identity, rejection
and cleanup. Reject unknown hashes and missing, duplicate or already-transformed
anchors. Compile the actual
verified production source independently with `cache:false` and `cache:true`
using `vm.Script`, without running it; both must retain the hook and empty-session
corrections, and only the latter may contain the asset-cache wrappers. Compile
the prepare source separately and verify that it contains no hook correction.
Controlled original-script checks place artifacts in owned TEMP and use
event-specific JSON stdin with a verified cwd/project environment without
`.codegraph`. For
UserPromptSubmit, include a synthetic prompt and assert the original nudge's
output semantics: without a project `.codegraph`, exit0 emits no context and
does not reach its gate-state reset. Compare generic shell-string execution
against login and nonlogin Git Bash, recording exit code,
stdout/stderr, elapsed time and owned descendants. Hook completion alone does
not establish old-session resume latency.
Use the isolated startup matrix with `--managed --fs-probe` to compare native
resource reads with cache-pack reads. Report preparation separately from connect
time; a fresh process/profile does not establish a cold OS filesystem cache.
Verify original artifact digests, native identities, actual terminal results,
permissions and replay behavior after packaging and in the desktop.
