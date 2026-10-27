# Local Document Link Opening

## 1. Scope / Trigger

Read before changing Markdown document links, their preload bridge or OS dispatch.
Native answers can contain `/C:/...html`, drive paths or `file:///` URLs. These
are documents to open explicitly, not trusted app-window navigation or executable
commands. The general web opener remains HTTP(S)-only.

## 2. Signatures

```ts
localDocumentLink(value: unknown): LocalDocumentLink | null
localDocumentHref(value: string): string | null
openLocalDocumentLink(value: unknown, projectRoot: string | null, stillCurrent?: () => boolean): Promise<LocalDocumentOpenResult>
// ipcInvoke.shell.openLocalDocument = 'shell:openLocalDocument'
api.openLocalDocument(href: string): Promise<{ ok: true } | IpcFail>
api.acpPiDocumentOpen(input: PiDocumentOpenInput): Promise<LocalDocumentOpenResult>
api.acpPiDocumentCancel(operationId: string): void
```

`LocalDocumentLink` contains `path`, `absolute` and `fragment`. The shared parser
checks syntax only; it never establishes filesystem authority. Main captures
`getProjectRoot()` when handling the IPC. Renderer supplies only an untrusted href.

## 3. Contracts

Markdown keeps sanitization enabled. Only anchor hrefs receive the document URL
transform; images and other attributes retain the default transform. Normalize
accepted absolute paths to copyable `file:///` hrefs, rather than resolving them
against the development server. Preserve HTTP(S) and same-document anchors.
Click and middle-click prevent app navigation and use the typed bridge once.

Relative documents resolve against the current main-owned project root. Absolute
documents must resolve inside that project, `app.getPath('temp')`,
`~/.codex/visualizations` or `~/.answer-me-with-html/pages`. Supported extensions
are `.html`, `.htm`, `.svg`, `.pdf`, `.md` and `.txt`. Main walks ancestors top-down before
following paths, rejects redirected descendants, checks canonical containment,
actual extension, ordinary-file status and readability, then dispatches a
`pathToFileURL(canonical)` URL (with fragment) to `shell.openExternal`.

Documents open in the normal OS-associated application, never inside a privileged
app BrowserWindow. No auto-open, broad `openFile` fallback or renderer-controlled
root is allowed. Replacing a file after validation and before the external
application reads it remains an OS-dispatch race, not a transactional guarantee.
Artifact-specific callers additionally pass a synchronous current-owner guard
checked just before OS dispatch; ordinary callers retain the default behavior.
Complete asynchronous owner checks before starting filesystem validation; do not
await another owner RPC between the last path check and dispatch.

Pi conversation entries expose HTML, HTM and SVG files only from matching
`source='pi'` native `write`/`edit` start and successful end records for the
same project, session, connection, turn and tool call. Model prose and failed or
partial tool results do not establish a file. The open request carries an
operation ID, expected project root, session ID, current connection generation
and the untrusted tool path. Main obtains the session's cwd from its own session
record, resolves native relative paths against that cwd, and requires the result
to remain inside the project. Absolute paths retain the document opener's root
fences. Main asynchronously rechecks session identity, connection generation and
cwd before filesystem validation, then synchronously checks project generation
and operation ownership immediately before dispatch. Selection changes, hidden
sources and unmounts cancel the pending operation. The endpoint authorizes the supplied path;
the conversation projection establishes its tool-result provenance. It never
reads file contents into the conversation.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Malformed escapes, controls, UNC/authority, unsupported scheme/extension | `E_INVALID_ARG`; no dispatch |
| Relative document without a current project | `E_NO_PROJECT` |
| Outside permitted roots, redirected descendant, non-regular file or unreadable target | `E_DENIED` |
| Missing target or invalid intermediate directory | `E_NOT_FOUND`; explain cleanup/regeneration |
| OS association/opener failure | `E_IO`; keep conversation and draft usable |
| Pi session or cwd changes before owner recheck, or project/operation changes before dispatch | `E_CONFLICT`; no dispatch |
| Old preload lacks the bridge | Visible full-exit/restart guidance; no alternate opener |

All main failures use `ipcFail`. Renderer errors appear beside the Markdown and
are gated to its still-current content/click owner; they are not console-only.
App-window navigation guards independently continue to reject other local pages.

## 5. Good / Base / Bad Cases

- Good: click the generated `/C:/Users/.../Temp/workflow.html`; a normal browser
  opens the existing file while the conversation stays unchanged.
- Base: a project-root-relative `docs/rules.md#section` opens a readable document;
  a `#heading` remains an in-document anchor.
- Bad: launch a shortcut/script, follow a junction to another root, or let a local
  href replace the app document. These must never dispatch or navigate.

## 6. Validation

Run `npm run typecheck`, `npm run build` and `npm run check:ui`. Use owned temporary documents and OS TEMP scripts to verify real Markdown/preload/main IPC behavior: native and encoded paths, copyable hrefs, click/aux-click, fragments, root fences, missing/denied files, junctions, dangerous targets and old-preload errors. Verify Pi write/edit result provenance, cwd-relative and absolute paths, delayed owner checks, file replacement before filesystem validation, and cancellation or project changes during validation. Preserve conversation/draft continuity and protected dev/file navigation. Verify the actual default document association separately; a simulated OS opener does not establish successful document rendering.

## 7. Wrong vs Correct

Wrong: pass any Markdown href to the old arbitrary file opener, or add `file:` to
the trusted app-window allowlist. Correct: retain sanitization/navigation guards,
authorize a narrow document through main, and open it outside the app on click.
