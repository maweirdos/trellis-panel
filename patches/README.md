# acpx compatibility patch

Upstream: [openclaw/acpx v0.19.5](https://github.com/openclaw/acpx/tree/v0.19.5),
published npm package `acpx@0.19.5`, MIT, copyright retained in the installed
`acpx/LICENSE`. The checked-in diff is our locally authored compatibility patch,
not a vendored source tree. `acpx/runtime` remains the public application boundary.

Compatibility revision **2** retains these three protocol boundary areas:

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

The patch also exports `TRELLIS_ACPX_COMPAT_VERSION = 2` and its public declaration
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

Behavioral checks: `node scripts/smoke/acpx-runtime.mjs` and
`node scripts/smoke/acpx-preparation.mjs`. Historical stock failure evidence under
the task's `research/validation/` is immutable and remains distinct from these
patched regressions.

## Eager persistent connection (revision 2)

`AcpxRuntime.connectSession({handle, assertActive?})` loads the existing persistent
remote session without recording/submitting a prompt or choosing a new session.
It reuses the manager's operation lock, `connectAndLoadSession` same-session-only
policy, preference replay, owner projection/checkpoint and canonical cleanup.
A live retained owner is reused; a newly loaded owner is retained for controls
and later turns. The app calls this when opening history, then publishes ready
only after actual load and metadata refresh. Failed load preserves history and
identity. Application prompt failures no longer end a healthy transport.
Focused regression: `node scripts/smoke/acp-continuity.mjs` (local fixture only).

Text checksums normalize CRLF and a single final newline, matching Git and
patch-package's Windows text handling; all other bytes must match.

## Passive unknown-update diagnostics

The approved R3 projection completes the existing inbound-ownership boundary.
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
