# acpx fixed-version compatibility implementation

Date: 2026-10-16. This implements the user-approved package-plus-minimum-patch
boundary. The immutable stock fixtures and research evidence were not modified.

## Delivered dependency boundary

- `acpx` exact0.19.5, MIT, upstream LICENSE retained unmodified. Product callers use
  public `acpx/runtime` and `acpx/agent-registry` exports.
- `patch-package` exact8.0.1 is a production dependency. The acpx-scoped SDK override
  is exact1.8.0, matching the original validation; resolved fs-safe is0.22.0.
- `patches/acpx+0.19.5.patch` changes the published client bundle, public runtime
  marker/declaration and permission decision declaration. `patches/README.md`
  records provenance, patch scope and the maintenance procedure.
- The public runtime exports `TRELLIS_ACPX_COMPAT_VERSION = 1`. The compatible
  permission extension is `{outcome:'selected', optionId:string}`; kind and cancel
  decisions continue to work. Missing, unknown or ambiguous exact IDs cancel
  without falling through to automatic approval. Trellis's mediator independently
  keeps invalid GUI choices pending before resolving the callback.

The patch remains within three areas:

1. Validate initialize's stable v1 version/consumed metadata before authentication
   and session/new; reject missing/empty session/new IDs before ensuring a session.
   Unknown capability metadata and nullable optional session capabilities survive.
2. Check raw incoming ownership before update reduction or delegated callbacks.
   Early new/load/resume updates buffer up to256 notifications /1MiB; no projection
   occurs until the authoritative identity is admitted. The whole accepted batch
   queues before later updates. Rejected/closed admissions discard the batch;
   replay suppression remains intact. Foreign permission requests return cancelled;
   foreign filesystem/terminal callbacks fail with request-cancelled before acting.
3. Select and validate original permission IDs exactly, retaining all original
   allow/reject kinds and existing cancellation/cleanup behavior.

## Preparation and guard behavior

`scripts/prepare-acpx.mjs` runs at postinstall and via `npm run prepare:acpx`.
It checks version/patch provenance, uses standard patch-package with error-on-fail,
then checks all five patched files plus the public marker.
`scripts/check-acpx-compat.mjs` also guards dev/build/dist/typecheck entrypoints.
Hashes normalize CRLF and one final newline because Git and patch-package can
normalize those on Windows; all other text must match. Unprepared, partially
patched, wrong-version or changed-patch states fail clearly.

The existing Vite8/electron-vite5 peer mismatch requires `--legacy-peer-deps` for
clean installation. No build-stack version was changed. Comparing old/new lock
entries found **zero existing package version changes**; npm deduplicated33 old
paths and introduced90 new dependency paths. The project .npmrc was preserved.

## Executed checks

- `npm run prepare:acpx` — passed, including idempotent reapplication.
- `npm run check:acpx` — passed against final patch and manifest.
- `npm run typecheck` — passed for both main and renderer, with pretypecheck guard.
- `node scripts/smoke/acpx-runtime.mjs` —19 cases passed against final dependency
  implementation. Evidence:
  `C:/Users/Maweirdos/AppData/Local/Temp/trellis-acpx-runtime-J9bBNi/results.json`.
  This covers all four original stock failures, malformed capabilities/missing
  version/empty ID, remote-ID coherent turns, split Unicode, tool patches,
  configuration/model acknowledgement, all four kinds, exact second same-kind
  choice, rejection, invalid selection even under approve-all, foreign traffic,
  early new/load/resume, overflow, same-session restart, replay suppression,
  failed restore without replacement, permission cancellation and closed admission.
- `node scripts/smoke/acpx-runtime.mjs --only=foreign` —3 cases passed, including
  the added foreign filesystem and terminal callbacks under approve-all. Replies
  were -32800 and no fixture file was created. Evidence:
  `C:/Users/Maweirdos/AppData/Local/Temp/trellis-acpx-runtime-lwswrL/results.json`.
- `node scripts/smoke/acpx-runtime.mjs --only=early` —2 cases passed after adding
  explicit pre/post-response ordering and the separate1MiB overflow regression.
  Evidence: `C:/Users/Maweirdos/AppData/Local/Temp/trellis-acpx-runtime-ocqgDf/results.json`.
  The final checked-in default suite contains20 named cases; the full19-case run
  plus these targeted reruns cover its final assertions.
- `node scripts/smoke/acpx-preparation.mjs --clean-install` —6 cases passed.
  A real locked production `npm ci --legacy-peer-deps --omit=dev --ignore-scripts`
  correctly failed the guard until explicit preparation; preparation was applied
  twice successfully. A second clean `npm ci --legacy-peer-deps --omit=dev` applied
  and verified the patch automatically through postinstall. Evidence:
  `C:/Users/Maweirdos/AppData/Local/Temp/trellis-acpx-preparation-cirIRX/results.json`
  and `clean-install/automatic-install.log` beneath that directory.
- `node --check` —all five added .mjs scripts/fixture passed.
- `git diff --check -- package.json package-lock.json` —passed (only Git's standard
  Windows line-ending notices).

All strict runtime launches used the owned Node peer and isolated temporary
directories. Every fixture launch received an exit observation. No real vendor
request, credential mutation, source-research rewrite, stage or commit was made
by this dependency workstream.

## Remaining integration acceptance

The coordinator owns real Codex/Claude sessions, native GUI/packaged startup,
directory authorization and lease policy, UI mediation, application quit, and the
final Trellis check. These deterministic package passes do not close vendor or
native acceptance rows. Future package/source migration must preserve this public
adapter boundary and rerun the strict tests; a version update cannot silently
reuse this fixed patch.

## Bounded metadata retention follow-up

Full review identified that stock public records discard negotiated mode choices,
agent identity and authentication-method display metadata. On2026-10-16 the
coordinator explicitly authorized completing that existing readiness/metadata
boundary; no new protocol command, authentication engine, observer or private
product import was introduced. The following optional public record fields were
agreed with the checker:

- `agentInfo?: {name:string;version:string;title?:string}`
- `authMethods?: Array<{id:string;name:string;description?:string}>`
- `acpx.available_modes?: Array<{id:string;name:string;description?:string}>`

The existing new/load result, record projection, state clone and file-store
serializer/parser now retain these fields and the advertised current mode.
Whitelisting excludes arbitrary handshake extensions and credentials. The patch
therefore also touches the dependency's existing persistence bundle, reflected in
the five-file hash manifest. A new strict scenario checks initial metadata,
mode acknowledgement, state cloning and native load with a changed advertised
mode label; a controlled secret-like fixture extension must never persist.
The final default suite contains21 named cases. Preparation additionally checks
the exact requested SDK override and the SDK actually resolved through its public
entry; a ranged override or installed1.9.0 fails against manifest.sdkVersion1.8.0.
No private SDK module is imported for this metadata check.

Final follow-up results against the completed metadata patch:

- `node scripts/smoke/acpx-runtime.mjs` —**21/21 passed**, with no skipped/failed
  cases and every fixture process observed exiting. Includes the new metadata,
  foreign callbacks, byte/count bounds and ordering assertions in the full run.
  Evidence: `C:/Users/Maweirdos/AppData/Local/Temp/trellis-acpx-runtime-RybtaK/results.json`.
- `node scripts/smoke/acpx-preparation.mjs --clean-install` —**7/7 passed**, including
  actual SDK drift and override rejection plus automatic clean production
  postinstall against the final patch and final SDK guard.
  Evidence: `C:/Users/Maweirdos/AppData/Local/Temp/trellis-acpx-preparation-XOnElk/results.json`.
- `npm run prepare:acpx`, `npm run check:acpx`, `npm run typecheck`, syntax checks
  on changed runtime bundles and the added scripts, and the scoped whitespace
  check passed after the metadata change. No dependency/patch edit remains pending.

## Bounded R3 unknown-update projection

The coordinator authorized completing passive unknown-update diagnostics inside
the existing inbound-ownership patch, without adding a host observer API, private
imports or unsupported protocol actions. An actual owned-peer baseline established
the distinction before the change:

- SDK1.8 accepts `notice`, but acpx's structured parser returned null and omitted
  it from public turn events.
- A completely new `sessionUpdate` tag is rejected by SDK1.8 before the host
  notification callback, with JSON-RPC -32602. Stock SDK error logging printed the
  controlled rejected raw frame, including its synthetic credential sentinel.

Baseline evidence is preserved at
`C:/Users/Maweirdos/AppData/Local/Temp/trellis-acpx-runtime-b4DIle/unknown-events/unknown-baseline.json`;
the original stock research evidence remains unchanged.

The public event is still `type:'status'`, optionally extended with `rawUpdate`,
`rawUpdateTruncated` and `payloadUnavailable`. Owned SDK-delivered updates that
acpx does not understand receive a passive bounded diagnostic. Unsupported tags
are classified against the SDK's **public** JSON-schema closed enum by the
existing internal tap. They are consumed before SDK raw-error logging and reduced
to tag-only diagnostics through the same ownership/early-buffer/cancellation/
replay gates. The text identifies SDK rejection; `payloadUnavailable:true` means
the original rejected payload was deliberately omitted. No unknown update can
settle a turn, signal readiness, grant permission or masquerade as a known tool.
Known done/error handling and text-origin `_meta` allowlisting were not broadened.

Sanitation limits are depth4,128 visited nodes,16 keys per object,8 array items
and6144 serialized UTF-8 payload bytes. Pre-redaction input limits are256 UTF-16
units per string,64 per key and128 per tag. Replacement markers can expand a
string; the byte accounting occurs after replacement. Secret-like keys and common
Bearer,`sk-`, credential-assignment and PEM private-key strings are redacted.

Focused actual-peer tests passed2/2 plus a child-stdio assertion with no credential
sentinel: owned/foreign unknowns, huge nested metadata, same-session early/load
replay, fake completed/error claims and legitimate later completion. No global
console interception is used. Evidence:
`C:/Users/Maweirdos/AppData/Local/Temp/trellis-acpx-runtime-MKi5Qs/results.json`.
The observe-only baseline switch was removed from the final regression script.

Final R3 production-clean preparation passed7/7, including automatic postinstall,
the new public SDK-schema import, repeated patch preparation and SDK drift guards:
`C:/Users/Maweirdos/AppData/Local/Temp/trellis-acpx-preparation-83Z77W/results.json`.
Typecheck, compatibility and syntax checks passed. The final complete runtime
suite passed **23/23**, without failures or skipped cases:
`C:/Users/Maweirdos/AppData/Local/Temp/trellis-acpx-runtime-Z5k8r4/results.json`.
This final run covers all previous contracts plus both R3 actual-peer scenarios;
all owned peer processes received exit observations. Dependency bytes stayed
stable throughout the focused/full/clean-install checks and parallel package QA.
