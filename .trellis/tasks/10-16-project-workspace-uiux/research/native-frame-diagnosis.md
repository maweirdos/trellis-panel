# Native outer-frame diagnosis — 2026-10-16

## Evidence

The user supplied the actual native Trellis window in `codex-clipboard-d34e1518-4a22-40bf-b9cb-1509832a9b27.png`. The dark rounded perimeter is visually separate from the rectangular renderer header/sidebar. The Codex reference has a quieter window perimeter. The precise Windows compositor state has not yet been captured; the screenshot alone cannot establish whether its color comes from the system accent, dark native theme, accessibility configuration or another native layer.

Repository inspection rules out an intentional renderer container outline:

- `src/renderer/src/App.tsx:197` ordinary root is a full-height flex canvas with no border, outline or radius classes. Preview uses the same composition at `:186`.
- `src/renderer/src/styles.css:53–58` gives `html`, `body` and `#root` only height/overflow. The dark/light body colors do not draw a frame.
- `src/renderer/src/my/my.css:5–45` root rules establish tokens. The focus-visible outline at `:187–192` applies only to buttons, links and `[role=button]`, not the shell root.
- The coordinator additionally measured light-mode HTML/BODY/#root/.my-root in the browser: border width 0, outline none and radius 0. Browser evidence does not capture Windows DWM decoration.
- `src/main/index.ts:132–150` creates the ordinary `BrowserWindow` with `frame:false`, a fixed dark `backgroundColor:'#0f1115'`, and no `accentColor` override. `thickFrame` and `roundedCorners` retain their Electron defaults. The repository has no `nativeTheme` usage.
- Installed `node_modules/electron/package.json:3` is **44.4.3**. Local `electron.d.ts:3164–3184` and `:3813–3821` expose the Windows border-accent API. `:4023–4031` explicitly documents that disabling `thickFrame` loses edge resize, shadow and animations.

## Primary-source contract

[Electron BrowserWindow API](https://www.electronjs.org/docs/latest/api/browser-window#winsetaccentcoloraccentcolor-windows) documents `setAccentColor(false)` as disabling active-window accent highlighting. The constructor also accepts `accentColor:false`. The documented frameless example supports this use without rebuilding the title bar or removing the resize frame.

The [matching Electron 44.4.3 Windows implementation](https://github.com/electron/electron/blob/v44.4.3/shell/browser/native_window_views_win.cc#L551-L588) provides stronger evidence: custom colors are applied through `DWMWA_BORDER_COLOR`; false disables the system accent and selects the native default border color. This does **not** mean “no border”. The implementation returns without applying that custom border path on pre-Windows-11 systems. It does not remove native sizing styles.

[Electron nativeTheme](https://www.electronjs.org/docs/latest/api/native-theme#nativethemethemesource) is application-wide and controls more than a single window border. It may be useful for general theme consistency, but its documentation does not establish that synchronizing it removes this Windows frame. Do not present it as a proven fix for this screenshot.

## Alternatives considered

1. Prefer a Windows-only `accentColor:false` constructor option on the **ordinary main window**. It disables system accent emphasis while preserving the existing frame, round corners, drag regions and standard resizing behavior. Do not change document, capsule or quicktodo modes in this scoped correction.
2. Capture the native focused and unfocused window after a main-process restart. If the heavy black outline remains, compare native default vs an explicitly chosen neutral `accentColor` matching the current app theme. This fallback requires a deliberate theme-update contract; it is not justified without that capture.
3. Matching the main-window background to the selected app theme can reduce a dark first-paint/resize seam, but it is not the documented border-accent control and should not be claimed to solve DWM decoration.

Never use `thickFrame:false`, `roundedCorners:false`, transparency, FFI or global OS setting changes to hide the problem. Those alter unrelated desktop behavior or accessibility. Do not suppress renderer keyboard focus in response to a native frame defect.

## Authorized implementation

The coordinator rejected default-border toggling as insufficiently deterministic and approved an explicit low-contrast theme-aware native border. The implemented correction is confined to the ordinary main window:

- New `src/main/services/window-appearance.ts` owns one mapping for existing semantic colors: canvas `#f2f2f3` / `#0f0f10` and border-subtle `#eaebec` / `#222425`, sourced from renderer `my-tokens.css:227`, `:282`, `:649`, `:704`. This small native mapping exists because DWM cannot consume renderer CSS custom properties.
- `src/main/index.ts` consumes the helper at main-window construction instead of a fixed dark background. Only Windows receives the explicit `accentColor`; no resize/corner/shadow option changes.
- Existing `src/main/ipc/settings.ts` applies appearance to the live main window only when the patch contains `theme`. No channel, schema or persistence extension is added. Null/destroyed windows are ignored; unrelated windows stay independent.
- The [matching public API implementation](https://github.com/electron/electron/blob/v44.4.3/shell/browser/api/electron_api_base_window.cc#L1068-L1089) immediately updates native border color after `setAccentColor`; no forced blur/focus cycle is needed.

## Verification status

Main-process TypeScript checking passed with `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json`. An ad hoc helper exercise passed existing-token matching, light/dark application, non-Windows omission of the Windows API, and null/destroyed-window guards. No persistent test was added for this small visual mapping. No processes were launched or killed by this implementer.

Native focused/unfocused capture, theme switching and drag/resize/snap/maximize/restore are owned by the coordinator and remain pending in this report. A browser screenshot cannot establish the native border's rendered result. Existing document-window and other pre-existing dirty main-process changes were preserved.
