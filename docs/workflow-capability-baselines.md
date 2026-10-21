# Workflow capability and performance baselines

Clean-room R0-02 diagnostic implementation. This document records observed
behavior and remaining gates; it is not a claim that the full workflow platform
or every engine/provider is ready.

## Run the bounded collector

From the project root:

```powershell
node scripts/smoke/workflow-capability-baseline.mjs --self-test
node scripts/smoke/workflow-capability-baseline.mjs --report-dir <new-directory>
node scripts/smoke/workflow-capability-baseline.mjs --report-dir <new-directory> --engine codex
node scripts/smoke/workflow-capability-baseline.mjs --report-dir <new-directory> --engine claude --turn-timeout-ms 60000
node scripts/smoke/workflow-capability-baseline.mjs --report-dir <new-directory> --jira --project HONSKY
```

`--engine all` tests both managed adapters. `--model <advertised-id>` is allowed
only with one selected engine, checks the actual session's advertised IDs and
verifies its isolated per-session acknowledgement. It does not change global
settings or silently switch to a fallback. Each run must use a fresh output
directory: a completed readiness record is never overwritten.

Defaults run no model/network probe. They inspect installed package/CLI metadata,
verify the current acpx compatibility patch, measure existing artifact files and
execute synthetic pure-compiler/document-digest measurements. Network/model
operations require their explicit flags. A collector exit code of zero means
collection completed, **not** that all readiness gates passed.

## Diagnostic boundary

- Use the published `acpx/runtime` exports and installed managed adapter entries,
  with explicit external Node argv. No `npx`, setup/install, SDK replacement or
  application runtime change occurs.
- Model probes use newly created owned temporary workspaces and synthetic README
  tokens. They read that file, cancel an acknowledged prompt and load the same
  recorded native identity. Prompts forbid unrelated files, writes, child agents,
  web and external resources.
- The normal exact permission mediator is retained. The probe can select an
  offered read/search permission only for the owned README path; other requests
  are rejected. No blanket approval is used.
- Runtime shutdown is awaited and owned launches/exits are recorded. Unknown
  process exits stay unknown. The collector never enumerates/kills unrelated
  processes or starts a visible desktop window.
- Existing settings/connector JSON is read with a 2MiB limit, without calling the
  configuration function that persists defaults on read. Jira usernames, passwords,
  headers and private prompts never enter reports or command arguments.
- If a protected Jira connector exists, an encrypted legacy secret is encountered,
  or an application proxy is enabled, this standalone Node diagnostic records a
  pending owning-adapter requirement. It does not decrypt with a fallback,
  reinterpret ciphertext as plaintext or bypass the configured proxy.
- For the observed enabled unencrypted legacy Jira source with no protected Jira
  connector, use its exact configured origin and Basic-header mechanism. Requests
  are GET-only, limited, abortable and refuse redirects. No comments, assignment,
  create, transition or other business mutation is performed.

## Current environment and evidence

Captured 2026-10-20. The independent gate index is
[research/readiness.json](../.trellis/tasks/10-20-wf-capability-baselines/research/readiness.json).
Raw bounded records retain their individual timestamps and methods.

| Installed item | Observed value | Meaning |
| --- | --- | --- |
| External Node | v24.12.0 | Actual version command/runtime |
| acpx | 0.19.5, compatibility marker 2 | Actual project checksum/export guard passed |
| Managed Codex adapter | 2.2.2 | Installed adapter metadata and real protocol process |
| Managed Claude adapter | 0.91.0 | Installed adapter metadata and real protocol process |
| Claude adapter SDK | 0.3.300 | Installed dependency metadata |
| Global Codex CLI | 0.163.0 | Separate global CLI version command |
| Global Claude CLI | 2.1.302 | Separate native CLI version command |

Global CLI versions do not prove which native executable a managed adapter chose.
The actual adapter entry and handshake producer are recorded. Do not combine
installation facts into a stronger unobserved engine-version claim.

Historical built-app acceptance from 2026-10-17 used acpx compatibility revision 1.
It remains useful dated evidence, but cannot close current revision-2 application
integration gates.

## Engine readiness

| Observation | Codex | Claude |
| --- | --- | --- |
| Actual new remote session identity | Observed | Observed |
| Actual prompt-written acknowledgement | Observed | Observed |
| Expected model greeting | Completed | Timed out at 30s and 60s |
| Fresh synthetic README token and tool events | Observed | Unknown after failed greeting |
| Cancellation after admitted prompt write | Cancelled settlement observed | Not run |
| Same recorded remote session loaded after runtime shutdown | Observed | Not run |
| Newly rotated file token after load | Observed | Not run |
| Provider usage fields | Present; raw counters retained | Unknown |
| Internal child-agent lifecycle | Unknown, not requested | Unknown, not requested |
| Native compaction | Unknown, not requested | Unknown, not requested |
| Owned process cleanup | Two launches/exits confirmed | All probe launches/exits confirmed |

The Codex subset is usable for the next scoped R1 stage-adapter verification.
It is not proof of production Trellis stage driving, application permission UI,
long-running tool cancellation, durable control recovery or full business flow.
The cancellation sample cancelled after transport admission, before evidence of
a long-lived tool. Retained usage counters are provider observations and must not
be summed as costs or normalized parent/child totals here.

Claude's current default was advertised as `opus`. An additional isolated run
selected advertised `zhipu/glm-5.3-flash[1m]` and confirmed that selection, but its
greeting still timed out after 60s. Selection acknowledgement is separate from a
working provider response. No global model change or automatic fallback occurred.
The complete Claude response/read/cancel/load gate remains pending investigation
of the current adapter/provider path. Further identical retries are not a fix.

Evidence:

- [Codex actual run](../.trellis/tasks/10-20-wf-capability-baselines/research/current/engine-codex.json).
- [Claude original default timeout](../.trellis/tasks/10-20-wf-capability-baselines/research/current/engine-claude.json).
- [Claude 60s default control](../.trellis/tasks/10-20-wf-capability-baselines/research/claude-retry-60s/engine-claude.json).
- [Claude explicit advertised-model control](../.trellis/tasks/10-20-wf-capability-baselines/research/claude-explicit-model/engine-claude.json).
- [Stored handshake metadata](../.trellis/tasks/10-20-wf-capability-baselines/research/stored-handshake-metadata.json), read through the public store after owned shutdown without another model request.

## Jira readiness

The existing configuration targets `http://192.168.1.202:8083`, project HONSKY.
The application proxy is disabled, and the relevant environment proxy variables
are absent. This standalone collector follows the same global-fetch/undefined
dispatcher branch as `proxy.ts` in that configuration, with the same 2MiB response
bound and redirect refusal. Its runtime is external Node rather than the active
Electron process; it does not claim an in-app IPC/provider acceptance test.

The final bounded diagnostic observed:

- configured-origin fetch failed with `UND_ERR_SOCKET`, remote endpoint
  `192.168.1.202:8083`, zero response bytes;
- a fresh no-credential TCP control connected to that port;
- a no-credential Node HTTP `GET /rest/api/2/serverInfo` control failed with
  `ECONNRESET` / socket hang-up, without an HTTP status or body;
- no redirect, credential change or business write occurred.

This means **TCP reachability exists, but HTTP responses are currently reset**.
It does not prove invalid credentials, missing permissions, a TLS problem or a
current Jira version. The earlier Server 8.1.0 metadata is dated evidence from
2026-10-18, not a successful revalidation today. After the first transport failure
the collector skips remaining authenticated metadata/search requests rather than
repeating the same failing call across every endpoint.

Once the HTTP path is available, `--jira` collects project/types, global field
schemas, required create fields, version references, permissions and an actual
issue's current-state transitions. Project search is GET-only, at most 20 pages
of 100 lightweight issue references. It records totals, unique IDs, duplicates,
malformed records and changes in observed totals. Partial scope is explicitly a
sample; it never becomes an empty complete version. This is not a frozen Jira
snapshot and never verifies business mutation outcomes.

The current Jira gate is **pending environment**, with
[precise transport evidence](../.trellis/tasks/10-20-wf-capability-baselines/research/final-static-jira/jira.json).

## Measured performance and limits

Machine: Windows (NT 10.0.26200) x64, Intel Core i9-14900HX, 32 logical CPUs,
34,070,192,128 physical-memory bytes. Measurements use external Node v24.12.0.
Concurrent workstation activity is uncontrolled; these are baseline samples,
not statistically established release budgets.

Existing file artifacts at collection:

| Artifact | Actual bytes | Interpretation |
| --- | ---: | --- |
| `out/` | 15,518,033 | 154 built files at capture, including timestamps/content-entry digests |
| `release/win-unpacked/` | 597,816,690 | Existing unpacked distribution; it may predate current HEAD |
| `release/TrellisPanel-Setup-0.1.0.exe` | 146,573,482 | Existing installer file, not rebuilt in this task |
| Installer blockmap | 152,528 | Existing blockmap file |

The builder's actual output directory is read from `electron-builder.yml`.
Installer/unpacked timestamps differ from current working-tree builds. The
collector records current HEAD separately; it does not assign that commit to an
older artifact whose embedded build identity is unknown.

Repeated pure shared-compiler measurements, one warm-up plus three samples:

| Synthetic nodes | Median compilation ms |
| ---: | ---: |
| 100 | 4.70 |
| 1,000 | 38.86 |
| 5,000 | 163.57 |

SHA-256 of a synthetic 2,400,027-byte UTF-8 document took 3.49, 2.95, 2.91,
2.97 and 2.97ms in five samples. These are real compiler/digest timings with
explicit synthetic inputs. They do not measure Markdown rendering, diffing,
canvas layout/paint, selection or native-window interaction. The diagnostic
Node RSS is not Electron idle memory and must not be shown as such.

A proposed 1.5× regression alert for these same-method medians is a provisional
comparison aid, not an accepted product SLA. Full packaged cold-start, controlled
idle/multi-session memory and native large-document/graph interaction budgets
remain pending actual controlled measurements. No visible application was
launched or substituted for the user's active app.

[Performance data](../.trellis/tasks/10-20-wf-capability-baselines/research/final-static-jira/performance.json)
records all individual samples, machine/runtime, artifact digests and remaining
native gates. Performance readiness is **partial**.

## How downstream tasks consume this

R1-02 may consume the Codex-ready subset now. It still verifies its actual
driver/material/output and application behavior. Claude response readiness, Jira
HTTP/metadata/writes, and full native performance stay separate pending gates.
Missing Jira access must not block unrelated desktop control/graph development.
R0-02 is not complete until its required real gates are satisfied and reviewed.
