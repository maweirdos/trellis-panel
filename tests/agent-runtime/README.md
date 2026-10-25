# Agent runtime checks

Install locked development dependencies with `npm ci --legacy-peer-deps`.
Use the project's supported external Node runtime; the tests enable type stripping
for the bundled ZCode translation module.

```powershell
npm run typecheck
npm run build
npm run check:ui
npm run test:agent-runtime
```

The default suite uses owned local peers, temporary projects and controlled
knowledge responses. It does not submit prompts to installed vendor services.
Protocol cases are split into four independent shards; each retains the original
case assertions and deadlines. The runner uses at most two child groups at once,
writes bounded logs under the system temporary directory and returns nonzero if
any group fails. Select a group family with `-- --only=knowledge`.

Coverage includes standard embedded-resource input, unchanged user text,
unsupported-capability zero-dispatch, role and skill snapshots, native MCP
discovery/cancellation and post-write receipts, exact bounded document pages,
page-version conflicts, project and generation fences, source ordering and
deduplication, owned tool-output replay, mounted role settings and Windows bulk
transport sealing. Adapter-specific tests remain under
`adapters/zcode-acp/test/`.

Conversation checks exercise simultaneous ordinary turns and exact permission
choices, exclusive managed workflows, independent cancellation, same-session
restore, idle connection eviction, all-busy capacity and uncertain cleanup.
Mounted switching checks retain drafts/images/references and prove selection
does not connect engines. Daemon checks cover build identity, replacement fences
and production application composition refusing active or unknown work.
Startup checks exercise bounded PID/time-bound failure diagnostics and the
actual Windows launcher: a temporary Unicode/spaced-path peer keeps running
after the helper's output pipes close, then exits independently. No inherited
control handles or shell evaluation are permitted.

Managed startup checks validate bundled Node/SQLite and licenses, physical
installation directory resolution, automatic preparation and exact official
fallback identity. Cache tests include independent trusted asset digests,
coordinated pack/manifest tampering, concurrent publication and source drift.
Empty-session tests require durable same-ID restore without fabricated prompts,
input/history/goal rows or title pollution.

Historical runtime-record tests also verify upgrading the recognized host-first
policy append on same-session restore while preserving frozen user instructions
and leaving custom prompts unchanged.

## Installed vendor evaluation

Live checks use the existing installed/authenticated runtime and an owned local
knowledge service. They create a temporary project and a native conversation;
they do not install adapters, change native settings, publish documents or create
Trellis tasks. Original one-shot permission choices are selected only for verified
reads inside the temporary project or that run's scoped knowledge tools.

```powershell
npm run test:agent-runtime:live -- --vendor=codex
npm run test:agent-runtime:live -- --vendor=claude
npm run test:agent-runtime:live -- --vendor=zcode --zcode-bin=C:/absolute/path/zcode.cjs
```

Managed Codex2.2.2 and Claude0.91.0 entries are resolved from the application's
installed runtime directory. ZCode accepts its explicit installed CLI path.
`--connection-only` measures native preparation without sending a model prompt.
Reports are written to each run's temporary `acceptance.json`.

For native ZCode startup subphases, run
`node tests/agent-runtime/zcode-startup.mjs --live --zcode-bin C:/absolute/path/zcode.cjs --project D:/absolute/project`.
Omit all arguments to test log projection without launching the vendor.
Compare equivalent cold and warm runs; a warm filesystem cache is not evidence
of a cold startup improvement.
Retain native plugin configuration and report actual readiness rather than
publishing an early synthetic ready state.

Use `--isolated-matrix --fs-probe` with the startup command to compare a fresh
temporary profile, an already seeded profile and the same session's resume.
The optional preload counts bounded startup I/O and hashes only in the owned
benchmark process; it preserves native reads/results and never caches production
authorization. A fresh profile does not imply a cold OS filesystem cache.

Add `--managed` to that isolated matrix to prepare the cache automatically and
measure complete managed app-server startup, including fresh-profile seeding.
Preparation time and cache-pack reads are reported separately. Original resource
read counts exclude the pack; neither category may be presented as zero total I/O.

```powershell
node adapters/zcode-acp/test/managed-empty-persistence-live.mjs C:/absolute/path/zcode.cjs
node adapters/zcode-acp/test/managed-plugin-cache-live.mjs C:/absolute/path/zcode.cjs
```

These live checks create only temporary profiles, send no model prompts, verify
native database counts and original artifact digests, and stop their owned
processes. They do not establish cold-OS latency or the real desktop flow.

Greeting, identity and general-knowledge cases require zero project lookup calls.
The business case requires actual scoped knowledge use and unseen role, skill,
file and evidence markers in the completed answer. Correlate native output with
the original completed tool ID. Evaluate the complete captured event stream;
the live metadata cache intentionally retains only800 events.

These checks do not establish deployed WeKnora availability, enterprise account
permissions, model quality across untested versions, or packaged GUI behavior.
Validate those environments separately before release. Dependency patch changes
also require `node tests/agent-runtime/acpx-preparation.mjs --clean-install`.

Inspect the actual copied adapter and pinned dependencies after packaging:

```powershell
npm run dist:dir
node tests/agent-runtime/acp-zcode-packaged.mjs --package-dir release/win-unpacked
node tests/agent-runtime/daemon-packaged.mjs --package-dir release/win-unpacked
```

The default inspection compares resource bytes and layout without launching the
packaged GUI or submitting model prompts. Its optional live mode is separate.

The daemon check launches the actual packaged control and daemon processes with
a new blank temporary profile. It verifies authenticated status, the exact role
bundle's build stamp and canonical original-owner exit. It sends no prompts and
does not open the user's profile or establish packaged GUI acceptance.
