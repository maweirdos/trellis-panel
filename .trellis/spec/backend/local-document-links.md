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
are `.html`, `.htm`, `.pdf`, `.md` and `.txt`. Main walks ancestors top-down before
following paths, rejects redirected descendants, checks canonical containment,
actual extension, ordinary-file status and readability, then dispatches a
`pathToFileURL(canonical)` URL (with fragment) to `shell.openExternal`.

Documents open in the normal OS-associated application, never inside a privileged
app BrowserWindow. No auto-open, broad `openFile` fallback or renderer-controlled
root is allowed. Replacing a file after validation and before the external
application reads it remains an OS-dispatch race, not a transactional guarantee.
Artifact-specific callers additionally pass a current-owner guard checked just
before OS dispatch; ordinary callers retain the existing default behavior.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Malformed escapes, controls, UNC/authority, unsupported scheme/extension | `E_INVALID_ARG`; no dispatch |
| Relative document without a current project | `E_NO_PROJECT` |
| Outside permitted roots, redirected descendant, non-regular file or unreadable target | `E_DENIED` |
| Missing target or invalid intermediate directory | `E_NOT_FOUND`; explain cleanup/regeneration |
| OS association/opener failure | `E_IO`; keep conversation and draft usable |
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

Run `npm run typecheck`, `npm run build` and `npm run check:ui`. Use owned temporary documents and OS TEMP scripts to verify real Markdown/preload/main IPC behavior: native and encoded paths, copyable hrefs, click/aux-click, fragments, root fences, missing/denied files, junctions, dangerous targets and old-preload errors. Preserve conversation/draft continuity and protected dev/file navigation. Verify the actual default document association separately; a simulated OS opener does not establish successful document rendering.

## 7. Wrong vs Correct

Wrong: pass any Markdown href to the old arbitrary file opener, or add `file:` to
the trusted app-window allowlist. Correct: retain sanitization/navigation guards,
authorize a narrow document through main, and open it outside the app on click.
