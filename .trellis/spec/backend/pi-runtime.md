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
