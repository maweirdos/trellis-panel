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

## 4. Validation and error matrix

| Case | Expected behavior |
| --- | --- |
| Light / dark main window | Matching existing canvas and subtle-border roles |
| Theme patch | Update live ordinary main window through the same mapping |
| Unrelated settings patch | No native decoration update required |
| Null or destroyed window | No-op, no native method call |
| Non-Windows | Background update only; no Windows accent API |
| Native capture unavailable/interrupted | Record unverified; do not claim border visually fixed |

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

## 7. Wrong vs correct

Wrong: `new BrowserWindow({ frame: false, thickFrame: false })` as a cosmetic workaround.

Correct: retain sizing defaults and merge `mainWindowAppearance(settings.theme)` into
ordinary window creation, then reuse `applyMainWindowAppearance` on the existing theme path.
