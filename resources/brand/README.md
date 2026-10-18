# Trellis Panel brand assets

`mark.svg` is the sole glyph source. The renderer's `BrandMark` masks it with
`currentColor`; no second hand-maintained path exists in TSX.

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
