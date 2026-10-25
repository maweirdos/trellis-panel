# App-window navigation boundaries

## 1. Scope / Trigger

Read before adding BrowserWindows, web links, redirects or external-opening IPC.
All frameless app windows retain the local app document and its close/navigation
controls. Ordinary web links open in the system browser.

## 2. Signatures

```ts
externalHttpUrl(value: unknown): string | null
openExternalHttpUrl(value: unknown): Promise<void>
installWindowNavigation(window: BrowserWindow, appDocumentUrl: string): void
loadAppWindow(window: BrowserWindow, query?: Record<string, string>): void
```

## 3. Contracts

`shared/external-url.ts` validates absolute HTTP(S) URLs, including hostname,
credentials, control/whitespace characters and percent escapes. Renderer routing
and main IPC use the same validator. The OS opener handles rejection without an
unhandled Promise; the existing external-open IPC stays `Promise<void>`.

`loadAppWindow` computes the actual dev/file document URL and mode/query, installs
the boundary before loading, then calls loadURL/loadFile. Main, document, capsule
and quick-todo windows all use it. Only that exact document and its fragments are
trusted; normalize equivalent query-space encodings. Rendered main-frame
navigation and redirects to another document are prevented. Valid web targets go
to the system browser; unsupported targets stay blocked. Every window.open
request is denied as an app popup, with valid external web targets routed out.
Opening an app document through privileged IPC remains an explicit separate flow.

## 4. Validation / Error Matrix

| Trigger | Result |
| --- | --- |
| Normal web link or target-blank link | OS opener called; app URL/content unchanged; no new unframed popup |
| Web redirect from a trusted load/reload | Prevent external app-document replacement; route valid destination out |
| Same-document heading/footnote fragment | Local navigation remains functional |
| Malformed URL, arbitrary scheme or another local document | No OS dispatch or app navigation |
| OS opener rejects | Keep the app usable; no unhandled rejection |
| Dev URL / packaged index + document mode query | Original app loads successfully with its correct mode |

## 5. Good / Base / Bad Cases

Good: a conversation source link opens in a normal browser while the conversation
and draft remain in the app. Base: an anchor scrolls within the document. Bad: a
bare Markdown href replaces the frameless main window, leaving no close/back UI.

## 6. Validation

Run `npm run typecheck`, `npm run build` and `npm run check:ui`. Verify dev HTTP and packaged file documents through real Markdown, preload and IPC: anchors, click/aux-click, target blank, plain-window navigation, redirects, malformed schemes, opener failure and cold reload. All window constructors must use the protected loader. Temporary local-server checks belong in OS TEMP and must stub external openers rather than launch unrelated apps or depend on public sites.

## 7. Wrong vs Correct

Wrong: protect only the Markdown click handler or create a borderless remote
window without close controls. Correct: route validated links out in the renderer
and independently protect every app webContents at the main-process boundary.
