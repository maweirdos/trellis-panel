# Ordinary main-window appearance

## 1. Scope / trigger

Use this contract when changing native window decoration or app-theme updates. Renderer
CSS cannot paint the Windows DWM perimeter. A black rounded native edge must not be
treated as a reason to remove renderer keyboard focus or native edge resizing.

## 2. Signatures

`services/window-appearance.ts` exports:

```ts
mainWindowAppearance(theme: Settings['theme'], platform?: NodeJS.Platform)
applyMainWindowAppearance(
  target: Pick<BrowserWindow, 'isDestroyed' | 'setBackgroundColor' | 'setAccentColor'> | null,
  theme: Settings['theme'],
  platform?: NodeJS.Platform
): void
```

## 3. Contracts

- Creation in `main/index.ts` consumes `mainWindowAppearance(getSettings().theme)` for
  the ordinary main window. The existing settings handler applies the same mapping to
  `getMainWindow()` only for a theme patch, after existing settings persistence.
- Native colors mirror existing renderer canvas and border-subtle semantic tokens in one
  centralized mapping. DWM cannot consume CSS custom properties; update both together
  if the semantic token values change. Do not scatter native color literals in callers.
- Windows uses supported Electron `accentColor` / `setAccentColor` to make the perimeter
  low contrast. Electron's custom DWM-border implementation applies on Windows 11;
  older Windows retains its supported native fallback. Non-Windows omits this option/call.
- `accentColor:false` selects native default, not a promise of no border. Do not substitute
  `thickFrame:false`: Electron documents lost edge resizing, shadow and animations.
- Keep existing resizing, rounded corners, snap and drag behavior. Do not introduce FFI,
  new dependencies, OS setting changes or application-wide nativeTheme overrides.
- Document/capsule/quicktodo windows keep independent behavior. No new channel, settings
  schema or persistence field is needed.
- Canonical renderer paint is dark `#121212` / light `#ffffff`; the supported native
  perimeter mirrors the subtle-border composite (`#2a2a2a` / `#e2e2e2`). Document
  creation reuses the background mapping; transparent utilities keep `#00000000`.
- `resources/brand/mark.svg` owns the application glyph. Main resolves committed PNGs
  relative to `out/main` via `../../resources/brand`; electron-builder includes that
  directory inside the app and applies `icon.ico` to the Windows executable and NSIS.
  All BrowserWindows use the application icon; the tray provides 16/20/24/32/40/48/64px
  tile representations for the corresponding display scales. Keep the
  packaged Windows AppUserModelID synchronized with `electron-builder.yml` appId
  (`com.mindfold.trellispanel`). Development uses the stable `.dev` suffix so the
  generic Electron host cannot seed or reuse the installed app's taskbar group.
  Set the process identity before readiness and before creating any windows.
- Every BrowserWindow receives `applyWindowsTaskbarBranding` through the central
  `browser-window-created` listener before showing. A BrowserWindow icon and a
  process AppUserModelID alone do not establish the taskbar group's Shell icon in
  development. Set the window AppUserModelID, relaunch icon, command and display
  name together. Development uses the committed ICO and a quoted Electron + app
  path command; packaged windows use the branded EXE's icon and command. Shell
  icon paths must be real OS files, never paths inside `app.asar`.
- Development additionally calls `prepareWindowsTaskbarShortcut(iconPath)` after
  readiness, before any window, IPC notification producer or UI hook is started.
  Electron44.4.3's native notification activator uses the executable ProductName
  (`Electron`) for `Programs/Electron.lnk`, not `app.getName()`. Its fallback link
  has no icon and empty arguments; matching `.dev` identity then associates the
  taskbar with that generic shortcut. Process/window IDs alone do not prevent this.
- Prepare that exact development link with the real ICO, quoted application path,
  `.dev` AppUserModelID, EXE-directory working directory and a toast activator CLSID.
  Preserve an existing owned link's CLSID: native validation adopts it and accepts
  the matching target/cwd/IDs instead of recreating a link without the icon/args.
  Only update an existing link when both its target is this Electron host and its
  identity is this app's development/legacy ID. Leave foreign links alone. A failed
  shortcut read/write warns and never blocks startup. Installed/other-platform
  applications skip this development repair; never rewrite the installed Electron SDK, clear
  global icon caches, change pinned-item settings or rotate arbitrary AppIDs.
- Windows `npm run dev` goes through `scripts/dev.mjs` and
  `prepare-dev-host.mjs`. It uses a content-addressed private runtime with all
  FileDescription translations set to `identity.json`'s application name, the
  canonical ICO, and a distinct development ProductName. Main/GPU/renderer/utility
  processes inherit that same executable metadata; `BrowserWindow.title` and
  `app.setName` alone cannot change the host's Task Manager description.
- Keep the private host filename `electron.exe`. Electron44's `app.isPackaged`
  checks that basename on Windows; renaming the binary changes runtime behavior.
  Do not override the property or rename/migrate userData to compensate. Source
  SDK files and release signing remain unchanged. Only the copied development
  EXE is resource-edited; shared companion files are read-only to the preparer.
- `TPANEL_BRANDED_DEV_HOST=1` selects the shortcut matching the branded host's
  development ProductName instead of `Electron.lnk`. Both values come from
  `resources/brand/identity.json`, included by the existing brand resources rule.
  Migrate a prior generic link only when its AppID, SDK target and quoted app
  argument all belong to this repository. A branded link may move to a new cached
  executable only within this repository's managed cache, with matching arguments
  and identity. Preserve the native-compatible cwd and toast CLSID throughout.
- Host preparation failure aborts the dev launcher rather than silently returning
  to generic Electron branding. An explicit `ELECTRON_EXEC_PATH` is an opt-out;
  other platforms keep the normal dev command. Never run preparation on build or
  distribution paths, and never delete/rewrite a running cached runtime.

## 4. Validation and error matrix

| Case | Expected behavior |
| --- | --- |
| Light / dark main window | Matching existing canvas and subtle-border roles |
| Theme patch | Update live ordinary main window through the same mapping |
| Unrelated settings patch | No native decoration update required |
| Null or destroyed window | No-op, no native method call |
| Non-Windows | Background update only; no Windows accent API |
| Native capture unavailable/interrupted | Record unverified; do not claim border visually fixed |
| Development taskbar icon | Independent `.dev` identity; Shell properties point to the ICO and application path |
| First development notification / restart | Owned Electron.lnk retains ICO, quoted app argument, native-compatible cwd and toast CLSID |
| Foreign Electron shortcut | No overwrite; warn while allowing application startup |
| Windows normal dev launch | Task Manager display metadata uses Crux for the host and its children |
| Branded development host | app.isPackaged stays false; existing userData and session locations are retained |
| Icon / identity / runtime update | New content-addressed host; previous running cache directory remains intact |
| Development ProductName shortcut | Distinct from installed app; native notification validation preserves icon/args |
| Packaged taskbar icon | Window Shell properties point to the branded EXE, outside `app.asar` |

## 5. Good / base / bad cases

- Good: apply theme-specific neutral accent without changing resize-frame options.
- Base: absent main window makes a theme update harmless; utility windows remain independent.
- Bad: hide the perimeter with thickFrame false, globally remove focus outlines, or modify
  the OS accent theme to match one application.

## 6. Required checks

Typecheck/build the main and renderer packages. Exercise theme/platform/window-liveness
branches and compare the centralized colors against the existing token source. Native
focused/unfocused light/dark captures and resizing/maximize/restore must establish the
actual visual outcome; browser screenshots cannot do that.

For branding changes, inspect the actual Windows window property store for the
AppUserModelID and all three relaunch properties in development and packaged
fixtures. Also capture the real taskbar with a visible window: readable NativeImage,
correct Shell properties, and a branded EXE do not prove the group's displayed icon.
A reproduced Windows 11 case had the correct HICON and all relaunch properties,
yet kept the old Electron group icon; a distinct development identity displayed TP.
Do not repeatedly clear system caches or change arbitrary IDs. Renderer refresh is
insufficient to load main-process changes.

Notification regression evidence: inspect `Programs/Electron.lnk` before and after
the first actual notification and on a subsequent launch. Check target, arguments,
icon/index, working directory, AppUserModelID and preserved toast CLSID. The
2026-10-18 recurrence had `.dev` on an `Electron.lnk` with empty arguments and no
icon. See Electron44.4.3's
[native notification registration](https://github.com/electron/electron/blob/v44.4.3/shell/browser/notifications/win/windows_toast_activator.cc).

## 7. Wrong vs correct

Wrong: `new BrowserWindow({ frame: false, thickFrame: false })` as a cosmetic workaround.

Correct: retain sizing defaults and merge `mainWindowAppearance(settings.theme)` into
ordinary window creation, then reuse `applyMainWindowAppearance` on the existing theme path.
