# Crux brand assets

`geometry.json` owns the 36 persistent pixels, the observer and C poses, and the
four loading/waiting groups. Each group contains four visible child squares.
`wordmark.svg` owns the vector lowercase wordmark and its woven x.

`scripts/generate-brand-assets.mjs` generates these production assets:

- `mark.svg`: the full observer glyph with two vertical eye pairs.
- `mark-16.svg`, `mark-20.svg`, `mark-compact.svg`: optical 16/20/24px glyphs.
  Every source remains a square; small sizes adjust their pitch and weight.
- `favicon.svg` and the desktop/team-Web public copies: the 16px optical tile.
- `icon-{size}.png`: 16/20/24/32/40/48/64/128/256/512/1024px application tiles.
- `icon.ico`: nine PNG-compressed frames, through 256px, including 125% and
  150% Windows DPI sizes.
- `tray-light.png` / `tray-dark.png`: transparent 32px glyph variants.

The renderer consumes the canonical files through `my/BrandMark.tsx` and
`my/BrandWordmark.tsx`. `my/BrandMotion.tsx` consumes the same geometry for
observation, C, loading and waiting. UI ink comes from `currentColor`.

Windows tray images include 16/20/24/32/40/48/64px representations for the
corresponding display scales. Window and native notification artwork uses the
application tile. The executable and installer/uninstaller use `icon.ico`.
`crux-concept/` remains an authoring reference and is excluded from packages.

Regenerate with an installed copy of sharp, used only during authoring:

```sh
npm run generate:brand -- /absolute/path/to/node_modules/sharp
```

Omit the argument when sharp is resolvable locally. Runtime and packaging use
the generated files and require no image-processing dependency. Regeneration
does not read the concept directory.

Run `npm run check:ui` after regeneration. It checks same-source vectors,
favicon copies, PNG dimensions and embedded ICO frames. Inspect rendered
small sizes, both themes and the actual Windows taskbar/tray separately.

## Windows identity

`identity.json` owns the Crux display name and its distinct development
ProductName. The packaged AppUserModelID remains `com.mindfold.trellispanel`;
development adds `.dev`. Existing userData, protocol and daemon identities are
retained. Display-name changes must not change those storage or routing keys.

`npm run dev` prepares a private Electron runtime under
`node_modules/.cache/trellis-panel/electron-host/<fingerprint>`. Its version
resources use the display name and development ProductName, and its executable
embeds the canonical ICO. The cache key includes the source runtime, ICO,
identity, application version and preparation script. Updates publish a new
cache directory while existing running versions remain intact.

The private executable keeps the filename `electron.exe`, which Electron uses
to distinguish development from packaged mode. The installed SDK remains
untouched. Release metadata and signing remain electron-builder's responsibility.

An owned previous development shortcut may migrate to the current ProductName
when its AppID, application argument and target identify this repository. The
native toast CLSID is retained. Foreign shortcuts are left unchanged.
