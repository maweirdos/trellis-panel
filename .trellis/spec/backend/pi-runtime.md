# Native Pi execution

## Ownership and dependency boundary

`pi` is a native SDK runtime alongside ACP, not an ACP adapter. The existing
daemon conversation controller owns project admission, directory leases, turn
identity, permissions, application history, handoff lineage and shutdown.
`services/pi/runtime.ts` implements that controller's in-process port. Legacy
`Acp*` DTO names do not imply that Pi sends ACP initialize/session messages.

Pin `@earendil-works/pi-coding-agent` and its Pi dependencies to1.4.0. Keep Pi
types and public SDK imports inside `services/pi/engine*`; renderer and business
code consume Planner DTOs. Use the public package exports and supported
extensions; do not import private `dist` paths, fork the SDK or patch its loop.
Model API factories use public `@earendil-works/pi-ai/api/*.lazy` exports rather
than the deprecated compatibility registry.

Product platform nodes follow [Product task execution](./product-task-execution.md).
Use the original private native owner and T03 node-scoped context; do not assemble
a second local Trellis baseline or load private material paths into the model.
The shared host's actual prompt-write receipt establishes delivery. Keep ordinary
Pi role/skill behavior unchanged outside the platform-node path.

For a platform tool permission, validate current execution authority, await the
existing permission result, then recheck the active turn and physical tool paths
after the wait. A path resolved before an asynchronous authorization is not
evidence that it still names the same allowed directory.

## Process and transport

Build `engine.ts` into an independent ESM entry. Start it with an absolute,
validated external Node>=22.19; distribution includes Node24.12.0. Never use
Electron's executable as the Pi Node runtime or start another GUI controller.
On Windows, the fixed `windows-pi-engine.ps1` supervisor assigns the suspended
SDK process to a kill-on-close Job Object before resuming it. Descendants cannot
break away. Normal shutdown terminates remaining job members and confirms zero
active processes; exit70 retains cleanup ownership. Do not replace this with
root-process exit or an unverified persisted PID.

The private protocol uses LF-only JSONL, bounded40MiB frames and distinct
acceptance, prompt-started and settled receipts. This bound accommodates the
public20MiB raw image allowance plus base64 and metadata. Read output continuously.
Fence asynchronous failures to the actual run. Deadline cancellation failure
must join canonical shutdown rather than leave a pending turn or rejection.
Observe response/deadline promises before waiting for writable backpressure.
Handle stdin/stdout/stderr errors and shutdown rejections explicitly. A timed-out
buffered prompt cannot survive into a successor turn. Configuration failure
closes the uncertain SDK owner before further input is admitted. An accepted
private prompt response establishes admission; it does not establish a model
answer or native persistence.

## Models, tools and resources

Resolve only enabled application model configurations. Keys use memory-backed
SDK credentials; do not write ordinary `auth.json`, expose keys to renderer or
inherit ambient model credentials. Preserve existing proxy configuration and
reject later mutation when model/credential/proxy or selected MCP configuration
revisions change; reconnect explicitly. Errors must redact reflected credentials
before both event delivery and native persistence.
Reuse the existing AI endpoint resolver, including exact full-URL overrides.
Ollama uses its OpenAI-compatible `/v1` interface rather than native NDJSON.
Recover unavailable saved models only after explicit selection from saved
advertised candidates and a new SDK acknowledgement, preserving native identity.

All SDK native and MCP tools pass the host permission extension. Validate physical
project paths before dispatch and after approval. Read-only mode denies mutation
and shell tools; workspace mode asks before writes, commands and unknown MCP tools.
Automatic approval is an explicit session mode, not an OS sandbox.

### Managed Windows file-search dependency

#### Scope

The Windows x64 Pi child uses the public SDK's native `find` tool and its fd
semantics. The child runs with `PI_OFFLINE=1`; missing executables cannot be
downloaded by the SDK during a turn. Provision fd before development/build/packaging.

#### Signatures

`scripts/prepare-pi-tools.mjs` exports `preparePiTools({root?,platform?,arch?,fetchImpl?})`.
`configurePiFindRuntime(engineUrl)` validates the prepared assets and prepends
their directory to this Pi child's PATH. `find-runtime-release.json` pins fd
10.3.0, the official Windows x64 release URL, archive SHA-256, executable digest
and both license digests.

#### Contracts

Keep `postinstall`, `predev` and `prebuild` acpx guards and prepare the tools in
those same lifecycles. `prepare-pi-runtime.mjs` also prepares the external runtime
closure. Cache verified assets under `node_modules/.cache/trellis-pi-tools` and
copy them beside the engine into `out/pi-engine/node_modules/trellis-pi-tools`.
Do not modify SDK source, install globally or inherit an unverified executable
ahead of the managed copy. Preserve the original SDK glob/ignore/limit/abort
behavior and host path/permission extension.

#### Validation and errors

| Condition | Behavior |
| --- | --- |
| Verified cache exists and network is unavailable | Prepare and execute find without downloading |
| First preparation has no valid cache | Fetch the pinned official archive with a 60-second timeout and 20 MiB limit |
| Archive/assets have wrong digest or redirected destination | Fail preparation without accepting the assets |
| Windows child has missing/invalid tools | Fail initialization with an actionable prepare/reinstall error |
| Non-Windows | Leave the existing SDK dependency resolution unchanged |

#### Cases

Good: an offline installed child finds a project-local module with
`pattern='**/three.module.js'` using its packaged fd. Base: development reuses
the verified cache. Bad: each chat discovers missing fd and attempts a download.

#### Required validation

Use isolated directories and the actual SDK find tool with no system fd and
offline mode. Cover basename/path globs, hidden and ignored files, limits,
cancellation, nonexistent paths and the unchanged permission boundary. Verify
cached preparation without fetch, invalid archives/assets, external runtime
closure and runtime byte-integrity rejection.

#### Incorrect and correct

Incorrect: hide `find` failures or replace native glob behavior with a partial
walk. Correct: ship its verified dependency and preserve the public SDK tool.

Register the native knowledge bridge as `trellis_knowledge` within the SDK
process, retaining its original scoped URL and bearer grant. The short alias
avoids provider tool-name truncation. Only exact host knowledge read tool names
receive read treatment; a project MCP tool with a similar suffix is not trusted.
Reserve that namespace from project configuration. Turn admission, source/version
fences, response delivery and revocation remain in the existing knowledge service.
Greetings do not cause host-first retrieval.

Additional project MCP servers are explicitly named by profile `mcpServerNames`
in `.pi/mcp.json`; enable only the selected stdio/Streamable HTTP entries. Do not
load inherited global MCP, arbitrary project extensions, command-valued secrets
or codemode as an authorization shortcut. ResourceLoader uses selected project
`skillPaths` and bounded project instruction files. Skill manifests do not grant
tool execution permission. Role snapshots remain session-specific.

## Authoritative assistant text

### Scope

Apply to SDK assistant deltas, block completion, message completion and all
consumers of saved Pi text. Final provider content can retract whitespace,
rewrite a streamed block or clear it; prefix inequality is not a turn failure.

### Signatures

```ts
meta.phase?: 'commentary' | 'final_answer'
meta.piText: {
  version: 1; messageId: string; blockIndex: number;
  blockType: 'text' | 'thinking'; operation: 'append' | 'replace';
  providerMessageId?: string; authority?: 'block_end' | 'message_end';
}
replayConversationTextEvents(events: readonly TimelineEvent[]): TimelineEvent[]
```

### Contracts

`AssistantTextStream` owns one SDK assistant message. Use a host-generated
message ID and exact source/root/session/connection/turn/block ownership.
`append` carries only a suffix; `replace` carries the full authoritative block,
including an empty string to clear it. Replacement requires a completion
authority. Phase and provider signature metadata must survive transport and
archive replay even when no text changes. Consume only public SDK metadata;
thinking signatures stay opaque.

Keep original events append-only. Replay into first-event anchors before
transcript compilation, catalogue preview, title material or handoff extraction.
A loaded replacement is independently readable without its earlier prefix.

### Validation and errors

| Condition | Required behavior |
| --- | --- |
| Final content retracts trailing newlines or rewrites a block | Emit scoped replacement; complete normally |
| Final block disappears | Emit empty authoritative replacement |
| Same event overlaps loaded history | Apply once per exact owner and event ID |
| Missing owner, mismatched message/kind or malformed structured block | Exclude malformed projection; never treat replacement as ordinary append |
| Another turn, connection or message shares a block index | Keep independent blocks |

### Cases

A streamed `draft` replaced by `answer` displays and summarizes only `answer`.
An unchanged final block emits no redundant text. Appending the full final
message to its draft produces duplicate output and violates this contract.

### Required validation

Exercise delta/block-end/message-end through the engine and runtime, including
whitespace retraction, empty/remapped blocks, late phases, repeated completion,
history overlap, partial-page replacement and owner isolation. Assert identical
authoritative text in transcript, catalogue, title input and handoff context.

### Incorrect and correct

Incorrect: throw on final-prefix mismatch or hide the error while retaining the
draft. Correct: record a validated authoritative replacement and replay it for
every text consumer.

## Images, provider events and thinking

Chain and await the SDK's existing `onProviderStreamEvent` callback before
observing its read-only provider event. Preserve extension event delivery and
stream order. Capture `image_generation_call.result` from a completed output
item or the completed response; deduplicate repeated representations of the
same call. A declared completed image without a result fails the turn visibly.
Do not add image-generation parameters to unrelated provider requests.

Store generated images under their owning Pi session by SHA-256; validate base64,
image signature, 10 MiB per image, and at most eight images and 20 MiB per turn.
History stores references, not generated-image base64. Resolve a reference only
for the exact project and Pi session, including an owned active session or its
retained snapshot when history is unavailable. Verify the file digest and type
on read. Use the existing 96 KiB RuntimeBlobs transfer for large daemon results;
each daemon frame remains below 256 KiB. Image export requires the user's native
save dialog selection and rechecks the project generation before writing.

Show tool images only after the tool reports success; partial and failed tool
results do not establish a successful image. The SDK still retains tool-result
images in its canonical model context and native JSONL. Resume rejects a native
session file over 128 MiB; the separately stored presentation images do not
remove that limit. Preserve the original session and report failure rather than
discarding tool images needed by the model.

Project thinking only from SDK events. A thinking block that starts and ends
without visible text records the explicit empty-content status; no thinking
event implies no such status. Record `response.created` as a provider response
observation and the first visible content as a separate observation, including
image-only output; old first-response history labels remain readable. Verify
missing results, duplicate callbacks, scoped history recovery, failed and
partial tools, empty thinking, and a large image across the actual daemon pipe.

## In-app static webpage preview

`preview_web` artifacts reference a project-root-relative HTML entry. Main makes
the authorization decision independently of artifact title/revision or tool
provenance. Resolve `artifact.path` against the project root, including when the
Pi session cwd is a subdirectory. The artifact does not grant filesystem access.

```ts
api.acpPiWebPreviewOpen(input: PiWebPreviewOpenInput): Promise<PiWebPreviewOpenResult>
api.acpPiWebPreviewStatus(id: string): Promise<PiWebPreviewStatusResult>
api.acpPiWebPreviewClose(id: string): Promise<{ ok: true } | IpcFail>
api.acpPiWebPreviewOpenExternal(id: string): Promise<{ ok: true } | IpcFail>
// Open success: { ok: true, preview: { id, url, path, revision } }
// Status success: { ok: true, revision }
```

Register these channels through the existing main IPC registry. Main captures
the actual project root/generation and calling webContents. Resolve the exact
Pi session from main-owned live/history metadata; verify its project, session
ID, cwd and connection generation. An optional request generation is an expected
value, not authority: when omitted, capture the current main-owned generation
and retain that fence for the lease. Cwd must remain a local directory inside
the project. Recheck the session before and after asynchronous resource reads.
Only the app main frame may create, inspect or close its leases.
Opening a preview in the system browser accepts only a lease ID. Main resolves
its URL after checking the owner, project, session and readable entry, then
rechecks the calling window and project generation before OS dispatch. Renderer
address text is never authority to open an arbitrary URL.

Each lease owns an ephemeral HTTP server bound to `127.0.0.1`, a separate random
256-bit capability URL and random lease ID. Serve only ordinary static files in
the HTML entry's directory and descendants; never list directories, execute a
project command, run a development server or proxy a remote URL. Reject absolute
artifact paths, parent traversal, encoded separators, UNC/network shares,
symlinks/junctions, hardlinks, hidden/system/sensitive names and non-static
extensions. Walk ancestors before following paths, verify canonical project
containment and canonical filenames, and compare open-file identity/metadata
before and after bounded reads. Windows Hidden/System/ReparsePoint and mapped
drive checks use a fixed, bounded OS metadata query without profiles or project
commands. Check Windows short-name aliases against their canonical names too.

Support HTML/HTM, CSS, JS/MJS, JSON, wasm, glTF/GLB/bin, common images and fonts
with explicit MIME types and `nosniff`. glTF uses `model/gltf+json`, GLB uses
`model/gltf-binary`, and bin uses `application/octet-stream`; the same physical
path, sensitive-name and 16 MiB file limits apply. Resource URLs are relative to
the capability URL.
Validate the exact loopback Host and reject non-null Origin headers. Responses
use `Access-Control-Allow-Origin: null`, no credentials and `Cache-Control:
no-store`. The response CSP allows scripts, styles, imports, fetch and wasm only
from that lease's exact origin/path, with inline scripts/styles and local
data/blob image support; it denies external resource connections, nested frames,
objects, forms and base-URL changes. Both renderer iframe and response CSP use
`sandbox allow-scripts`; do not add `allow-same-origin`. The app document's
frame source allowance retains `'self'` for existing same-origin/srcDoc previews
and adds only `http://127.0.0.1:*` for the loopback server.

Install a main-owned `will-frame-navigate` and `will-redirect` guard on existing
app window webContents during IPC registration and on newly created windows,
before any preview Open. Use a WeakSet to prevent duplicate installation. Permit
initial `about:srcdoc`/`about:blank` for existing code previews. Bind each preview
frame's stable frame-tree node ID to its first authorized lease and permit HTTP
navigation only to that still-current owner's exact capability origin/path and
allowed static resource names. Reject other ports, other leases, foreign or
closed leases, network destinations and nested frames. Retain that binding
through redirects and prune detached frame IDs. Parent frame-src and resource
CSP alone do not authorize iframe document navigation; do not rely on
`navigate-to` or a script injected into the preview for this boundary.

Limit preview leases to eight total and four per owner, including pending opens;
files to 16 MiB each, 128 tracked resources and 64 MiB total per lease. Bound
active HTTP responses to sixteen total/eight per lease, retaining the count
through finish/close so slow clients cannot bypass it. Apply bounded socket,
header, request and send timeouts. Leases expire after 30 minutes idle or two
hours total. Owner close, document navigation/reload, renderer loss, destruction,
project root/generation changes, session/cwd/connection changes and confirmed
app exit invalidate the lease and close its server/sockets and cached metadata.
Use `will-quit` for app disposal because `before-quit` can be cancelled.

Status hashes actual entry bytes and every successfully served resource. A
syntactically allowed static resource requested but missing on disk also receives
an unavailable baseline in the same 128-item bounded map; invalid paths, denied
files and non-static extensions never enter it. First discovery of either a
present or missing resource establishes its baseline without changing revision.
Changed content, first creation after a 404, resource deletion or restoration
advances revision once;
unchanged polls remain stable even after iframe reload or newly discovered
assets. Order resource observations so delayed missing or successful reads cannot
overwrite a newer hash. Entry loss or denied ownership invalidates the lease. Artifact revision
and filesystem timestamps alone are not the refresh revision. Polling the
1500 ms status API remounts the iframe only when the returned revision changes.

| Condition | Result |
| --- | --- |
| Invalid input or lease ID | `E_INVALID_ARG` |
| Missing current project | `E_NO_PROJECT` |
| Foreign window, unsafe file or excessive file size | `E_DENIED` |
| Stale project/session/owner or file changes during reading | `E_CONFLICT` |
| Missing entry or released lease | `E_NOT_FOUND` |
| Lease/resource quota exceeded | `E_BUSY` |
| Repeated close of an unknown valid ID | Success; no other lease is affected |

Validate root-relative entries with subdirectory cwd, live and historical
sessions, unchanged polls, entry/module edits, resource deletion/restoration,
opaque-origin multi-file modules/fetch/wasm, blocked external requests, hidden
files/short aliases/junctions/traversal, bounded reads/slow responses and exact
owner/generation/quit cleanup. Verify actual Electron navigation from an initial
srcDoc before Open, JSON read followed by cross-port self-navigation, HTTP 302
redirects, cross-lease/foreign/closed destinations, permitted same-lease pages and
existing srcDoc rendering; the destination server must receive zero rejected
navigation requests. Verify missing-module creation advances revision once,
invalid requests do not consume tracking slots, and model MIME/size limits hold.
Keep fixtures, scripts and reports in OS TEMP.
Good: relative modules and JSON load inside one lease and edits refresh it.
Base: unchanged status never reloads the frame. Bad: trusting an artifact path
or revision as authorization, resolving it against cwd, or serving resources
outside the checked entry directory.

## Persistence and distribution

Pi SessionManager owns canonical model context, branches, tool results and
compaction. Planner metadata owns native-file association and presentation
indexes. Resume validates the private path, cwd, header/version and ancestry;
corrupt/future files fail closed. Preserve an exclusive versioned backup before
supported old-format migration. Never replay uncertain tool side effects.

Package the complete unmodified SDK production closure outside ASAR for external
Node. `prepare-pi-runtime.mjs` derives installed dependency closure and excludes
only Pi-exclusive names from ASAR through the public electron-builder build API.
Host-shared dependencies remain independently resolvable. Keep required workers,
WASM, platform assets and license notices. Development imports alone do not prove
packaged resolution.

Upgrade pinned dependencies only after checking public API/config/event changes,
TEMP compatibility probes with saved-session copies, credential/permission and
cancel behavior, compaction/resume and applicable Windows packaging. Keep session
backups and a rollback path; current v3 migration is not a guarantee of future
bidirectional compatibility. Follow the root local-only validation rule.
