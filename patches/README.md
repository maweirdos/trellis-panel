# acpx compatibility patch

Upstream: [openclaw/acpx v0.19.5](https://github.com/openclaw/acpx/tree/v0.19.5),
published npm package `acpx@0.19.5`, MIT, copyright retained in the installed
`acpx/LICENSE`. The checked-in diff is our locally authored compatibility patch,
not a vendored source tree. `acpx/runtime` remains the public application boundary.

Compatibility revision **3** retains these protocol boundary areas:

- Validate ACP v1 initialize metadata and nonempty new-session identity before readiness.
  Retain only public agent identity, authentication-method display fields and
  advertised mode choices through the existing record/store boundary; credentials
  and arbitrary handshake extensions are excluded from these snapshots.
- Admit inbound session messages only for the owned remote session. Up to256
  notifications /1MiB of early new/load/resume updates remain unprojected until
  the authoritative identity is confirmed; rejected/closed admissions discard them.
  Load replay suppression is preserved. Foreign permission and delegated callback
  requests fail closed before handlers can act.
- Add `{outcome:'selected', optionId:string}` to `AcpPermissionDecision`, preserving
  kind/cancel decisions. Unknown or duplicate IDs cancel without mode fallback.

The patch also exports `TRELLIS_ACPX_COMPAT_VERSION = 3` and its public declaration
as an explicit integration guard. SDK1.8.0 is scoped via an acpx override to keep
the protocol dependency aligned with the original isolated validation. Preparation
checks both the requested override and the actual SDK resolved from acpx's public
dependency boundary; changing the lock or installed SDK cannot silently bypass it.

`patch-package@8.0.1` is an exact production dependency so ordinary and production
installs both prepare the runtime. Supported source preparation:

```powershell
npm ci --legacy-peer-deps
npm ci --legacy-peer-deps --omit=dev
npm run prepare:acpx
npm run check:acpx
```

`--legacy-peer-deps` is required by the repository's existing Vite8 /
electron-vite5 peer mismatch; this change preserves that build stack. `postinstall`
applies the patch and verifies pinned version, patch checksum, patched-file hashes
and the public marker. Standard dev/build/dist commands check it again. If install
scripts were skipped, explicitly run `npm run prepare:acpx` before building.
Never edit `node_modules` as a deployment step, patch a different version, or
remove a failing check. After an intentional compatibility update, regenerate the
diff with `node node_modules/patch-package/index.js acpx`, update
`acpx-compat.json` hashes and rerun both smoke suites.

Behavioral checks: `node tests/agent-runtime/acpx-runtime.mjs` and
`node tests/agent-runtime/acpx-preparation.mjs`.

## Windows process inventory

Live descendant trackers in one ACP host share one lazy, hidden PowerShell
helper. Each request runs a new full `Win32_Process` CIM query at the existing
awaited capture boundary. Completed tables are never cached. Birth/PID, root,
unknown-identity and canonical cleanup rules remain in the original inventory
consumer; identity-only requests filter the newly collected full table.

The helper accepts decimal request IDs only and executes a fixed internal script.
Responses require matching BEGIN/END IDs, exact row/ASCII-byte counts and valid
creation identities. Limits are32 pending requests,65536 rows,32 MiB per table
and160 bytes per protocol line. Requests serialize without sharing completed
results; queue wait counts toward each caller's original deadline. Invalid,
truncated, failed or timed-out queries disable the helper until every tracker in
that shared scope retires. Remaining deadline permits one existing one-shot
query; an exhausted deadline preserves the original failed/unknown observation.

Both paths use absolute Windows PowerShell with `windowsHide:true`, no profile,
and inherited environment with `PSModulePath` isolated to `$PSHOME/Modules`.
The helper explicitly imports `$PSHOME/Modules/CimCmdlets/CimCmdlets.psd1`;
fixed path concatenation avoids module discovery for `Join-Path` and CIM commands.
`PSModuleAnalysisCachePath=NUL` disables module-cache writes, including relative
cwd fallback when a test host has no Windows Known Folder for LocalAppData
([Windows PowerShell5.1](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_5.1?view=powershell-5.1)).
Helper stderr is discarded; errors contain no process rows or launch arguments.
The last retired tracker closes stdin and synchronously terminates the exact
helper child handle before releasing its pipes. The read-only helper has no
business state to flush; shutdown cannot depend on a timer surviving host exit.
Idle child and pipe handles are unreferenced; host exit also terminates the
helper. EOF independently exits the script if the host is terminated.

`dist/windows-process-query.js` is an internal patch artifact, covered by the
same manifest hashes. Public ACP exports and compatibility revision3 are
unchanged. Run `node tests/agent-runtime/windows-process-query.mjs` for fresh
tables, identity/cleanup safety, framing bounds, concurrency, failures/deadlines,
EOF and real Windows host/helper exit checks.

## Persistent connection (revision 2)

`AcpxRuntime.connectSession({handle, assertActive?})` loads the existing persistent
remote session without recording/submitting a prompt or choosing a new session.
It reuses the manager's operation lock, `connectAndLoadSession` same-session-only
policy, preference replay, owner projection/checkpoint and canonical cleanup.
A live retained owner is reused; a newly loaded owner is retained for controls
and later turns. The app calls this on explicit Send or retry, then publishes
ready only after actual load and metadata refresh. History selection only reads
saved state. Failed load preserves history and
identity. Application prompt failures no longer end a healthy transport.
Focused regressions: `node tests/agent-runtime/conversation-concurrency.mjs` and
`node tests/agent-runtime/conversation-switching.mjs` (owned peers only).

Text checksums normalize CRLF and a single final newline, matching Git and
patch-package's Windows text handling; all other bytes must match.

## Inline text resources (revision 3)

`AcpRuntimeTurnInput.context?: Array<{uri:string; mimeType?:string; text:string}>`
adds standard ACP `{type:'resource',resource:{uri,mimeType?,text}}` blocks after
the original text and before image/audio attachments. Supplied text and URI
strings are preserved exactly. An absent or empty context keeps the previous
wire behavior, including image-only turns. The manager, public wrapper,
`runTurn` and shared runtime use the same conversion and validation.

Before dispatch, context must contain at most 16 resources, each at most
128 KiB of UTF-8 text and at most 256 KiB combined. URIs must be absolute `file:`
or `trellis:` URIs, at most 2048 characters, without credentials, ASCII whitespace or
literal/percent-encoded control characters. File URIs require an absolute path.
MIME may be omitted or exactly `text/plain` or `text/markdown`. Invalid input
fails with `ACP_TURN_FAILED` before sending a request. Runtime validation does
not read files or access the network; the host supplies resource text and
negotiates the agent's `promptCapabilities.embeddedContext` capability.

`node tests/agent-runtime/acpx-runtime.mjs --only=context` checks exact resource/text
bytes, attachment order, empty context, byte/count/URI/MIME bounds with zero
dispatch, cancellation, subsequent turns, eager resume and the shared runtime
against an owned local peer.

## Bounded tool output deltas

Owned tool updates preserve text from the recognized `terminal_output_delta`,
`terminal_output` and `mcp_output_delta` metadata channels as `outputDelta`.
Other metadata is excluded. Each delta retains at most16384 UTF-16 units without
splitting a surrogate pair; `outputDeltaTruncated` discloses an omitted suffix.
Delta content never establishes tool completion or grants permission. The host
keeps the original scoped tool ID and native completed/failed acknowledgement.
Renderer replay appends deltas in event order with a separate display cap.

## Passive unknown-update diagnostics

Unknown-update projection completes the existing inbound-ownership boundary.
For an owned update delivered by SDK1.8 but unrecognized by acpx, the public
`AcpRuntimeEvent` remains `type:'status'` and carries its tag, readable text and
optional `rawUpdate`. This diagnostic never acknowledges a feature or changes
turn/readiness/permission state. Known terminal events and the existing text
origin `_meta` allowlist keep their original behavior.

`rawUpdate` sanitation is bounded to data depth4,128 visited nodes,16 keys per
object,8 array elements and6144 UTF-8 serialized bytes. Pre-redaction inputs are
limited to256 UTF-16 units per string,64 per key and128 per tag; redaction markers
can expand those strings. The total payload byte cap still applies after
redaction. The event envelope is separate.
Deep or excessive content is omitted/replaced and `rawUpdateTruncated` is set.
Secret-like keys (auth/token/password/secret/cookie/credentials/API/private keys)
have redacted values. Bounded string values also redact common Bearer,`sk-`,
credential-assignment and PEM private-key patterns. Metadata remains untrusted
producer data and grants no authority.

SDK1.8's stable `SessionUpdate` parser rejects completely unknown tags before
its host callback. The existing internal tap classifies these tags against the
SDK's **public** `schema/schema.json` closed enum, consumes the rejected frame
before SDK raw-error logging and routes a **tag-only** diagnostic through the
same owned-ID, early-admission, cancellation and replay-suppression gates.
Its text explicitly identifies SDK rejection and `payloadUnavailable:true`;
the original rejected payload is omitted. There is no new observer API, private
SDK import or acceptance of an unsupported tool/state update.

`node scripts/smoke/acpx-runtime.mjs '--only=unknown' --assert-clean-stdio`
exercises actual owned-peer notifications, foreign unknown updates, oversized
metadata, early/native replay, credential sentinels and fake completed/error
claims. Child-process stdio capture verifies that rejected credential fixtures
do not reach SDK error logging; no global console interception is used.
