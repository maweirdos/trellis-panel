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
  Shell/sidebar/navigation roles are also available as `bg-my-shell`,
  `bg-my-sidebar`, `bg-my-navigation-hover/selected`, and `border-my-shell-line`.
- Type: `text-my-2xs/xs/sm/md/lg/title/xl/display`; body roles are
  `--my-text-ui/chat/document/activity`, with matching line-height variables.
- Radii: `rounded-my-xs/sm/inset/md/lg/xl/menu/3xl/4xl` map to
  2/4/6/10/12/16/18/20/24px. Round avatars and progress rings are geometric exceptions.
- Spacing: ordinary Tailwind 0.5 through 16 steps consume `--my-space-*`.
  Use `px-my-page`, `h-my-header`, `h-my-icon`, `h-my-control`, `h-my-field`
  for semantic layout metrics. Do not introduce unrelated local pixel scales.
- State: `my-control`, `my-input`, `my-menu`, `my-menu-item`, `my-tooltip`,
  `my-modal-backdrop`, `my-modal-panel`, `my-segmented`, `my-segment`,
  `my-chip`, `my-kbd`, `my-scrollbar`, `my-nav-item`, `my-activity-note`, `my-chat-prose`.
- Ordinary window surfaces: `--my-bg-shell` belongs to the title bar and module
  rail; `--my-bg-sidebar` belongs to contextual navigation; canvas belongs to the
  content. Light roles are #f6f6f6 / #fcfcfc / #ffffff; dark roles are #101010 /
  #141414 / #181818. `my-app-window` and `my-shell-layout` paint the shell with
  shared inset/radius/border tokens. Utility-window roots do not acquire that frame.
- Conversation geometry: place `my-conversation-column` inside
  `my-conversation-frame`. Transcript and composer use the same 760px maximum and
  24px gutters (20px at the compact breakpoint), including when an inspector changes
  the available width. Symmetric scrollbar gutters keep the center shared.
- Navigation hover/selected states consume dedicated navigation roles. Do not use
  general-purpose panel selection as the navigation background. Ordinary activity
  uses `my-activity-note`; failures and pending permissions retain semantic emphasis.
- Shared React primitives live in `my/ui.tsx`: Button, Dropdown, Modal,
  Checkbox, SearchInput, Tabs, Avatar, Tooltip and EmptyState.
- `Modal` portals into its owning App `.my-root`, outside page stacking and
  clipping contexts. Keep the root's theme/font inheritance and React interaction
  scope; do not portal to an unthemed body or add a nested `.my-root`. Its fixed
  `no-drag` backdrop covers the title bar as well as the page. Keep the existing
  modal stacking token, Escape dispatcher and focus containment/return behavior.
- Page geometry lives in `my/layout/PageLayout.tsx`, with exactly two variants:
  `PageLayout({ variant: 'full'|'centered', ...divProps })`. The exhaustive
  `PAGE_LAYOUTS satisfies Record<Page, PageLayoutVariant>` registry classifies
  every route, including new routes. `PageFrame` consumes that registry; pages
  with their own module header compose the same layout directly.
- `PageHeader`, `PageToolbar` and `PageNotice` provide fixed, aligned bands.
  `PageBody` fills the remaining height. A centered body owns one scrollbar;
  a full body delegates scrolling to its real workspace panes. Do not restore
  an additional scrolling wrapper around `PageBody` in `MyApp`.
  The full-width personal homepage explicitly owns scrolling in
  `PageBody.my-home-body`; it keeps global gutters and does not add a private
  maximum width. Its compact metrics and 9:3 task/record composition share one
  12-column grid. The standalone onboarding screen stays centered.
- `PageContent({ variant?: 'full'|'centered', ...divProps })` provides the page's
  horizontal and vertical insets; `PageSection` provides horizontal alignment for
  compact controls and footers. Without a variant they inherit the page contract.
  Nested reader/editor panes explicitly select one of the same two variants.
  Full workspaces can retain edge-to-edge tables, boards and split panes; their
  controls use `PageToolbar` or `my-page-toolbar-row`, and padded workspaces use
  `my-page-workspace-padding`.
- Canonical page content width is1120px, excluding the two24px gutters. The
  gutters become16px at960px. Content starts24px below its band and has48px
  bottom space. These values live only in `my-tokens.css`; headers, scope notes,
  toolbars and contents consume them from `my-shell.css`. Centered fixed bands
  reserve the same symmetric scrollbar gutter as their body. Remove old leaf
  `max-w-*`, `mx-auto`, `px-*`/`p-*` page wrappers when migrating; never stack
  page padding inside `PageContent`. Dialogs, table columns, individual controls
  and message bubbles may retain their own functional dimensions.
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

Unspecified/invalid font preference means standard (14px UI/document, 15px chat).
Explicit small/large remain 13/15px. Keep stored values, unrelated settings and
cross-window storage synchronization. Font controls remain in Settings only.
Metadata and activity use a smaller global text role. Heading line-height is1.2. Changing type never changes
reader/session identity. Chat uses 1.65 line height and a shared paragraph gap;
the same font step produces 14/15/16px chat across the three presets.
The 48px toolbar and module-rail width share `--my-shell-chrome-size` and do not
grow per font preset; fields
and buttons derive their heights from the type and padding metrics.

## 4. Interaction and validation matrix

| Case | Required result |
| --- | --- |
| Dark/light primary control | Correct inverse ink; normal text contrast at least 4.5:1 |
| Danger control | On-color text stays readable in every theme |
| Input/select | Same single-line height; textarea may grow |
| Keyboard focus | Neutral visible outline or token focus shadow |
| Text-field focus | One subtle border, without an extra outline/shadow; preserve faint keyboard focus on buttons and non-text controls |
| Menu near viewport edge | Actual measured menu remains inside the viewport |
| Narrow dialog | Panel fits the viewport without a document horizontal scrollbar |
| Centered route | Header, scope note and body share1120px content width and the same gutter; body alone scrolls |
| Full route | Header stays fixed; tables/editors/panes fill the remaining space and retain their own scroll owners |
| Page migration | No old outer max-width or duplicate page padding; reader/session keys and interaction scopes are unchanged |
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
