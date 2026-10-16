# Research: acpx 0.19.5 Windows lifecycle and launcher validation

> Clean-room experiment. Fixtures, assertions, and these notes were independently authored. Only published entrypoints and installed public declarations were used; no private runtime imports, source patches, vendor prompts, or copied upstream implementation.

- Query: Does the published embedded runtime provide usable Windows launch, cancellation, process-ownership observations, and cleanup behavior for a Trellis integration?
- Scope: internal, bounded headless Windows experiment against the installed published package
- Date: 2026-10-16
- Package: `acpx@0.19.5`; installed at the user-authorized visualization `acpx-validation/node_modules/acpx` directory
- Host: native Windows, Node `v24.12.0`; no Electron GUI or packaged application was involved

## Findings

### Result

**12 selected lifecycle scenarios passed their recorded assertions.** This establishes a useful embedded-runtime integration seam for these controlled Windows processes. It does not establish compatibility with an actual Codex/Claude adapter, arbitrary descendant processes, or packaged Electron launch environments.

The authoritative selected result is [validated-results.json](validation/lifecycle/validated-results.json). Each selected case points to its preserved `result.json`, fixture JSONL, lifecycle JSONL, store/profile directory, and supervisor ownership check. Earlier calibration/debug runs remain preserved and are explicitly superseded.

| Scenario | Observed behavior |
| --- | --- |
| Explicit executable/script paths with spaces | A local copy of the actual Node executable under `Node Runtime With Spaces` launched `agent fixture.mjs`; initialize/new/prompt completed. |
| Restricted child PATH and literal argv | Child PATH contained only an empty owned directory. `literal spaces & metacharacters` arrived as one unchanged argument. The completed turn returned `end_turn`. |
| Initialization failure cleanup | Deliberate ACP initialize error `-32603` propagated. Started child emitted an exit observation and was gone without supervisor intervention. |
| Pre-spawn hook rejection | Rejecting `onBeforeSpawn` rejected ensure and created no fixture process. |
| Post-spawn hook rejection | Rejecting `onSpawned` rejected ensure; the child exited and an exit observation was recorded. |
| Missing executable | Explicit missing owned `.exe` path produced `AgentSpawnError` with underlying `ENOENT`. Hooks were before → spawn_failed, without a started PID. No package-exec fallback was used. |
| Cancel active turn | Fixture received `session/cancel` for its remote session and completed the held prompt. Canonical turn result was `cancelled`. |
| Shutdown ready session | `runtime.shutdown()` settled; the known Agent PID was already gone at the post-shutdown check. |
| Shutdown busy session | Active prompt received cancellation, canonical result was `cancelled`, shutdown settled, and the known Agent PID was gone. |
| Shutdown during initialize | Shutdown closed the initializing transport. Ensure rejected with `AgentStartupError`; the fixture received no `session/new`, and the child exited. |
| Cancel turn while reconnecting | Cancellation requested after the second process received initialize. It later completed initialize/load but dispatched **no prompt**, returned canonical `cancelled`, and exited on cleanup. Cancellation is not an immediate pre-handshake process kill. |
| Owned grandchild and `.cmd` launcher | In separate cases, an unref'ed owned Node grandchild was gone after runtime shutdown, and an owned `.cmd` with a space in its filename successfully initialized a session. The latter lifecycle PID referred to `cmd.exe`, while the fixture recorded the actual Node PID. |

The table groups related checks for readability; the assertion aggregate contains **12 distinct named cases**, including separate grandchild and `.cmd` cases.

### What processLifecycle actually gives the host

The installed public `AcpProcessLifecycle` declaration exposes before-spawn, spawned, spawn-failed and exit observations. The experiment exercised all four:

- Before-spawn carries `launchId`, ownership scope, executable, argv and cwd. Runtime-session scope includes `sessionKey`.
- Spawned adds the actual launcher PID and start time. On a `.cmd` launch that PID is the Windows command interpreter, so it must not be labeled as the vendor engine PID without another observation.
- Spawn failure includes the attempted launch and failure time/error; a missing executable has no valid started PID.
- Exit joins back to the same launch identity and records exit code/signal/time.
- Before/spawned callbacks are effective admission boundaries in these tests: throwing stops startup, and a process rejected after spawn was cleaned before the observed operation finished.

These facts support a Trellis-owned process ledger and truthful “launching / process started / session ready / failed / exited” presentation. They do **not** expose a dedicated callback for “ACP handshake complete” versus “session/new complete”. `ensureSession` completion establishes a ready session; separate protocol milestones need an additional public observation surface or must remain omitted. Do not infer those milestones from process spawn or arbitrary stderr strings.

### Windows timing observations

Cleanup is asynchronous and should remain visibly pending until its canonical promise/result settles. In the selected ready-session case, the last Agent exit observation arrived about **1.35 seconds** after shutdown was requested; the final report followed about **4.47 seconds** after that request, including the explicit post-check/finalization delay in the harness. In the initial successful launch/turn case those values were about **1.44 seconds** and **7.38 seconds**.

These are individual observations on this host, not benchmarks or timeout recommendations. The aggregate's `actionToReportMs` includes test post-check/finalization work and is **not** a direct measurement of the shutdown promise alone. Busy/cancel cases include turn finalization and subsequent runtime cleanup. The reconnect-cancel case took longer because it includes a seed session, its shutdown, a second initialize/load, cancellation and final cleanup.

An early 1.6-second initialization budget and later 4-second calibration budgets produced inconclusive failures. Those runs also changed environment setup, callback conditions and path layouts; no isolated root cause was proven. They are not recorded as acpx compatibility failures. Selected tests use an 8-second runtime deadline, bounded operation deadlines and a 30-second outer per-case deadline.

### Grandchild evidence and its limits

The grandchild fixture was created by the Agent fixture using the same explicit Node executable and original script, with its own nonce and a 20-second self-exit guard. It used ignored stdio, was unref'ed, and had no parent-exit listener. The final selected case finished in about **8.26 seconds**, both known PIDs were gone after runtime shutdown, neither watchdog self-exit event was recorded, and the supervisor performed no forced cleanup. This supports ordinary descendant cleanup in the tested tree.

It does not prove behavior for detached/breakaway processes, vendor launchers that transfer ownership, terminals, Windows Job Objects, host crashes, forced Electron termination, or descendants running with different privileges. Those require separate native host/vendor acceptance.

### Explicit registry override and installation boundary

Every selected fixture launch resolved through `createAgentRegistry({ overrides: { 'fixture-local': argv } })`. The recorded resolved argv matched an owned explicit executable/script or owned `.cmd`; no built-in vendor alias was selected. The missing-executable case failed on that path rather than asking npm/npx to obtain an agent.

No dependency install was performed by this experiment. The only executable copy is the already-installed local Node binary under the owned, ignored `validation/lifecycle/node_modules/Node Runtime With Spaces/` directory. It is a test input, not a proposed shipped runtime or source dependency.

The public registry can still list built-in agents; the assertion here concerns the **selected explicit override path**, not a guarantee that arbitrary default/built-in resolution is installation-free.

### Session identity during reconnect

The first reconnect test expected changed registry argv to replace the saved session's launcher/stage. The observed saved identity retained the original launch information instead, so that test's stage predicate was wrong and was superseded. The corrected test controls initialization delay with an owned fixture sentinel file and detects the second process by timestamp/PID.

That corrected run verifies cancellation during the public reconnect operation: a second initialize and `session/load` occurred, no `session/prompt` occurred, and the canonical result was cancelled. The test neither modifies a runtime store record by hand nor uses a private factory. Profile/launch changes and existing session identity should therefore be treated explicitly in the integration rather than assuming registry edits silently rewrite saved sessions.

## Files Found / Code Patterns

| File | Description |
| --- | --- |
| [agent fixture.mjs](validation/lifecycle/agent%20fixture.mjs) | Original fake ACP Agent, bounded slow initialization/error/busy/grandchild modes, minimal request/response logs |
| [agent-entry.mjs](validation/lifecycle/agent-entry.mjs) | Original no-space launch-path calibration entry |
| [run-lifecycle.mjs](validation/lifecycle/run-lifecycle.mjs) | Public runtime/registry experiment, sanitized worker environments, per-case supervisor and PID ownership checks |
| [summarize-lifecycle.mjs](validation/lifecycle/summarize-lifecycle.mjs) | Assertions over the selected preserved runs; creates the stable result aggregate |
| [validated-results.json](validation/lifecycle/validated-results.json) | 12 passing case results, selected evidence paths, current fixture hashes and measured intervals |
| `validation/lifecycle/runs/2026-10-16T10-09-00-530Z/summary.json` | Main 11-case batch; its first reconnect-stage predicate is superseded by the corrected run below |
| `validation/lifecycle/runs/2026-10-16T10-10-13-238Z/summary.json` | Additional missing-executable/spawn-failure case |
| `validation/lifecycle/runs/2026-10-16T10-10-52-264Z/summary.json` | Corrected reconnect-startup cancellation case |

Public declaration boundaries inspected in the installed package:

- `dist/runtime.d.ts`: `createAcpRuntime`, `createFileSessionStore`, runtime options, turn `promptStarted/events/result`, cancel/close/shutdown, and process lifecycle types.
- `dist/agent-registry.d.ts`: explicit argv overrides, registry resolve/inspect interfaces.
- `dist/session-options-*.d.ts`: re-exported public process launch/start/failure/exit and permission/authority types; read as declarations only.
- `package.json`: exact 0.19.5 version and public `./runtime` / `./agent-registry` export mapping.

No private manager constructor, test factory, client import, source implementation or upstream patch was used.

## Reproduction

From the workspace root, with the exact installed package still available at the path recorded in the runner:

```powershell
node '.trellis/tasks/10-16-acp-runtime-foundation/research/validation/lifecycle/run-lifecycle.mjs' --plain-cwd
node '.trellis/tasks/10-16-acp-runtime-foundation/research/validation/lifecycle/run-lifecycle.mjs' --only spawn_failure --plain-cwd
```

The current runner includes the corrected reconnect predicate and calibrated time budgets. `summarize-lifecycle.mjs` validates the **preserved selected runs** at the recorded paths; a new execution creates a new run directory and should be selected deliberately before regenerating an aggregate. Current fixture hashes identify the retained reproducer files, not immutable copies of every earlier diagnostic revision.

All worker profile, temporary, child cwd, state and log paths are owned directories under `validation/lifecycle`. Worker environment replacement removes inherited credentials before public imports; the invoking shell environment is unchanged. Agent child PATH is separately restricted. No real model traffic or outbound account authentication occurs.

## Related Specs

- `.trellis/spec/guides/decisions.md` TPD-009: independent notes/fixtures, no copied upstream source/patches; dependency license review remains required before product introduction.
- `.trellis/spec/frontend/my-ui-module.md`: project isolation and live-only actionable permissions; switching project must not shutdown other projects' agents.
- `.trellis/spec/frontend/ipc-electron.md`: launch/native operations belong behind typed IPC, not renderer code.
- `.trellis/spec/shared/code-quality.md`: preserve errors and truthful operation state.

## Caveats / Not Found

- Actual Codex/Claude ACP adapter behavior, authentication, permissions, model/config semantics and their native session history are outside this lifecycle experiment; the protocol peer owns separate protocol validation.
- Selected successful cwd paths contain no spaces. Executable, script and `.cmd` filename spaces are verified. Earlier cwd-space calibration runs changed multiple conditions and do not establish a valid cwd-space verdict; retain that as a future acceptance case.
- No GUI, packaged Electron, bundled Node discovery, `ELECTRON_RUN_AS_NODE`, environment inherited from a GUI launcher, application quit/crash, Windows Job integration or detached-process tree was tested.
- `shutdown` here is the embedded runtime's ownership cleanup. The shared-runtime API has different detach/owner semantics and was not exercised.
- All selected cases had no known live PIDs at the supervisor check and required no supervisor force-cleanup. Earlier timed-out diagnostic workers were cleaned only after their current Windows command line matched an owned script and unique nonce. No unrelated process was targeted; no recursive deletion was issued.
- All generated artifacts are preserved. The ignored local Node alias should remain an experiment input and should not be committed or shipped as product code.
