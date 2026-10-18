# Global CSS and design system

## 1. Scope and ownership

Every renderer surface, including document/capsule/quick-todo windows, uses the
`my` design system. Read this before adding UI or changing a visual value.

The only bootstrap imports are `my/my.css` then `styles.css` in `main.tsx`.
`my.css` imports these files in order:

- `my-tokens.css`: canonical colors, fonts, type scale, line heights, weights,
  spacing, radii, control/layout metrics, shadows, motion and stacking levels.
- `my-components.css`: shared control, field, menu, tooltip, modal, focus and
  selection rules. Values come from the token file.
- `my-shell.css`: shell composition and responsive geometry using those tokens.

`styles.css` owns Tailwind directives, reset/native-window rules and Markdown/
architecture presentation. It consumes the same tokens; it is not another palette.
Domain sheets such as `acp/workspace.css` compose these roles without overriding
brand, typography or radius values. Keep theme values in `my-tokens.css` only.

## 2. Public style and component API

- Colors: existing `bg-my-*`, `text-my-*`, `border-my-*` map to `--my-*` variables.
- Type: `text-my-2xs/xs/sm/md/lg/title/xl/display`; body roles are
  `--my-text-ui/chat/document/activity`, with matching line-height variables.
- Radii: `rounded-my-xs/sm/inset/md/lg/xl/menu/3xl/4xl` map to
  2/4/6/10/12/16/18/20/24px. Round avatars and progress rings are geometric exceptions.
- Spacing: ordinary Tailwind 0.5 through 16 steps consume `--my-space-*`.
  Use `px-my-page`, `h-my-header`, `h-my-icon`, `h-my-control`, `h-my-field`
  for semantic layout metrics. Do not introduce unrelated local pixel scales.
- State: `my-control`, `my-input`, `my-menu`, `my-menu-item`, `my-tooltip`,
  `my-modal-backdrop`, `my-modal-panel`, `my-segmented`, `my-segment`,
  `my-chip`, `my-kbd`, `my-scrollbar`.
- Shared React primitives live in `my/ui.tsx`: Button, Dropdown, Modal,
  Checkbox, SearchInput, Tabs, Avatar, Tooltip and EmptyState.
- `Avatar({ tone?: 'color'|'accent' })`: use `tone="accent"` with a neutral
  accent background. Arbitrary user identity colors retain semantic on-color ink.
- `BrandMark({ size?: number, className?: string })` uses the canonical SVG.

Example:

```tsx
<Button variant="primary" onClick={save}>保存</Button>
<input className="my-input" aria-label="名称" />
<div className="rounded-my-lg bg-my-layer-2 p-4 text-my-sm text-my-secondary" />
```

## 3. Theme and typography contracts

Application roots carry `.my-root`, `data-my-theme="light|dark"` and
`data-my-font-size="small|standard|large"`. Root document colors also follow
`html.dark` for initial paint. A nested `.my-root` must not reset a parent's
font step: use an ordinary content container inside the App-owned root.

The accent is neutral inversion: white on dark, dark ink on light. Filled accent
controls use `text-my-on-accent`; danger/colored controls use `text-my-on-color`.
Do not reuse constant white text on a white accent fill. Green is a success/
completion or user-label semantic color, never an application brand setting.
No legacy leaf variables/classes, private accent overrides or bundled Inter.

The default font is the platform system stack, including Segoe UI and Chinese
fallbacks on Windows. Code uses the global mono stack; box-drawing content uses
`--my-font-diagram` for its CJK character-width requirements. There is no font CDN.

Unspecified/invalid font preference means standard (14px UI/chat/document).
Explicit small/large remain 13/15px. Keep stored values, unrelated settings and
cross-window storage synchronization. Font controls remain in Settings only.
Metadata and activity use a smaller global text role. Heading line-height is1.2. Changing type never changes
reader/session identity. The 46px toolbar does not grow per font preset; fields
and buttons derive their heights from the type and padding metrics.

## 4. Interaction and validation matrix

| Case | Required result |
| --- | --- |
| Dark/light primary control | Correct inverse ink; normal text contrast at least 4.5:1 |
| Danger control | On-color text stays readable in every theme |
| Input/select | Same single-line height; textarea may grow |
| Keyboard focus | Neutral visible outline or token focus shadow |
| Menu near viewport edge | Actual measured menu remains inside the viewport |
| Narrow dialog | Panel fits the viewport without a document horizontal scrollbar |
| Font/theme change | Drafts, reading state and existing choices stay intact |
| Transparent utility root | Canonical font/colors without an opaque root background |
| Reduced motion | Remove nonessential playback; transition-duration is0s |
| Text/code/message selection | Copyable content remains selectable |

## 5. Good, base and bad cases

Good: add a missing semantic role in `my-tokens.css`, map it in Tailwind, and
compose the shared primitive. Update consumers and the spec together.

Base: user-defined label/identity/chart data may contain colors. They do not
establish a second application palette or justify a green brand fallback.

Bad: add a final CSS override block in a page to defeat the shared theme; write
`text-[13px]`/`rounded-[7px]`; define another local font stack; use a tint/focus
color unrelated to the global accent. Do not use `my.*` alpha suffixes such as
`bg-my-accent/20`; use the corresponding subtle/hover semantic role.

## 6. Required checks

Run `npm run typecheck`, `npm run build` and `npm run check:ui`.
`check:ui` detects missing/cyclic token dependencies and legacy brand usage,
verifies same-source SVG/PNG/ICO resources, then mounts real shared primitives
in Chromium across six theme/font combinations. It tests contrast, geometry,
focus, viewport-clamped menus, narrow dialogs and transparent utility roots.
Hidden-window focus uses Chromium focus emulation rather than OS focus stealing.

Run navigation, UIUX wiring, ACP and reader smoke checks for affected consumers.
Keep native appearance mapping synchronized with the canvas token (see backend
`window-appearance.md`). Browser captures do not establish Windows DWM/tray
visual behavior. Verify the actual UI with screenshots, including open states.

After changing Tailwind configuration, use a freshly loaded development process
or the production CSS; an existing process may retain the old configuration.

## 7. Wrong versus correct

Wrong: `bg-my-accent text-white` or a nested unconfigured `.my-root` in a document.

Correct: `bg-my-accent text-my-on-accent`, and a single App-owned typography root
with normal content wrappers inheriting its selected font scale.
