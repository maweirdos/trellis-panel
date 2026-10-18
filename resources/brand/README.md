# Trellis Panel brand assets

`mark.svg` is the sole glyph source. The renderer's `BrandMark` masks it with
`currentColor`; no second hand-maintained path exists in TSX.

`identity.json` owns the application display name and the distinct Windows
development ProductName. The latter also names the development notification
shortcut, so it must not collide with the installed application's shortcut.

Generated assets:

- `favicon.svg` and `src/renderer/public/favicon.svg`: neutral application tile.
- `icon-16.png` through `icon-1024.png`: window, taskbar, tray and application sizes.
- `icon.ico`: seven PNG-compressed frames (16/24/32/48/64/128/256).
- `tray-light.png` / `tray-dark.png`: transparent monochrome glyph variants.

The tray currently uses the small tile so the mark remains readable on either
Windows taskbar color. Main loads resources relative to the built main bundle;
electron-builder includes `resources/brand/**` inside the application and uses
`icon.ico` for the executable and installer/uninstaller.

Regenerate with an installed copy of sharp (authoring only):

```sh
npm run generate:brand -- /absolute/path/to/node_modules/sharp
```

Omit the argument when sharp is already resolvable locally. Runtime and packaging
use the committed files and require no image-processing dependency.

Run `npm run check:ui` after regeneration. It validates dimensions, ICO frames,
the shared glyph path and real Chromium theme/font/control behavior.

## Windows development process identity

`npm run dev` uses `scripts/dev.mjs`. On Windows, the launcher prepares a private
Electron runtime in `node_modules/.cache/trellis-panel/electron-host/<fingerprint>`
and passes its executable through electron-vite's `ELECTRON_EXEC_PATH`. It changes
all version-resource languages' FileDescription to `Trellis Panel`, sets the
development ProductName and embeds the canonical ICO. Main, renderer, GPU and
utility processes therefore share the same branded host metadata.

The cached executable retains the filename `electron.exe`: Electron44 uses that
filename to calculate `app.isPackaged`. Renaming it would incorrectly switch
development code into packaged behavior. The installed SDK binary remains intact;
only the private development copy has rewritten resources. Companion files are
hard-linked where supported and otherwise copied; they are never rewritten.
Resource rewriting produces an unsigned local development host, while release
executable metadata/signing remains electron-builder's responsibility.

The cache key includes the source binary, ICO, identity, application version and
preparation script. Updated hosts are published into a new directory, without
replacing or deleting a running version. An explicit `ELECTRON_EXEC_PATH` remains
an advanced toolchain override and bypasses this preparation. Non-Windows dev
launches use the normal installed runtime. CLI arguments, Vite's lifecycle and
the application's existing userData/settings/session locations are unchanged.
