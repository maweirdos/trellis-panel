# Global CSS and design system

视觉目标与验收遵守 [前端视觉与交互设计规范](./design-principles.md)：通过比例、留白、对齐、层级和连续反馈建立完整设计；精简说明后仍保留内容与操作的清晰度。动效应有交互职责，不制造强制等待或布局抖动。具体颜色、字体、几何与动效值继续使用本文规定的统一设计令牌，不另建平行样式体系。

## 1. Scope and ownership

Every renderer surface, including document/capsule/quick-todo windows, uses the
`my` design system. Read this before adding UI or changing a visual value.

The only bootstrap imports are `my/my.css` then `styles.css` in `main.tsx`.
`my.css` imports these files in order:

- `my-tokens.css`: canonical colors, fonts, type scale, line heights, weights,
  spacing, radii, control/layout metrics, shadows, motion and stacking levels.
- `my-components.css`: shared control, field, menu, tooltip, modal, focus and
  selection rules. Values come from the token file.
- `my-feedback.css`: neutral activity/result cards, `FeedbackNotice`, and
  `NotificationCard`; imported by the global `my.css` entry. Choose the
  surface with the [feedback mapping](./components.md#feedback-and-recovery).
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
- Interface names and supporting descriptions share `my-item-title` and
  `my-item-description`. The standard preset uses 13px/500 for names and
  12px/400 for descriptions; both follow the existing density step. Their size
  tokens are `--my-text-item-title/description`, and their colors are
  `--my-txt-item-title/description`. Names use the equal Oklab mix of primary
  and secondary text; descriptions use tertiary text. Domain selectors consume
  these same tokens when geometry already lives in a domain stylesheet.
  Remove conflicting local typography when adopting a role. Do not blanket-style
  `p`, `label` or heading elements, or rely on a class that a stronger local rule
  overrides. Preserve page/section headings, numbers, document/chat/code reading
  roles and status colors. Selected, hovered and filled surfaces must retain
  readable descriptions; use the contextual secondary/on-color role where needed.
  When a label wraps an editor or selector, put the title role on a text span;
  applying it to the wrapper leaks its weight into editable content and values.
- Radii: `--my-radius-base` is the single 10px source for ordinary rectangular
  components. Existing `rounded-my-*` and control/panel/shell aliases all resolve
  to it, independent of density. Functional circles/tracks use `full` or `round`;
  joined edges and fullscreen surfaces may use zero. New pages use the current
  Settings interface and `DESIGN.md` as their visual baseline.
  Declare radius tokens only in `my-tokens.css`; page styles and inline code must
  not redefine them. `check:ui` enforces the source, aliases and consumer values.
- Spacing: ordinary Tailwind 0.5 through 16 steps consume `--my-space-*`.
  Use `px-my-page`, `h-my-header`, `h-my-icon`, `h-my-control`, `h-my-field`
  for semantic layout metrics. Do not introduce unrelated local pixel scales.
- State: `my-control`, `my-input`, `my-menu`, `my-menu-item`, `my-tooltip`,
  `my-modal-backdrop`, `my-modal-panel`, `my-segmented`, `my-segment`,
  `my-chip`, `my-kbd`, `my-scrollbar`, `my-nav-item`, `my-activity-note`, `my-chat-prose`.
- Ordinary window surfaces: `--my-bg-shell` belongs to the title bar and module
  rail; `--my-bg-sidebar` belongs to contextual navigation; canvas belongs to the
  content. `--my-bg-panel`, `--my-bg-panel-header` and `--my-bg-input` separate
  grouped settings, section headings and fields. Theme values live only in
  `my-tokens.css` and keep strict zero-blue neutral (`R = G = B`) surface/text
  steps: Light lifts off muddy grey onto crisp paper white (`#f5f5f5` shell →
  `#f9f9f9` sidebar → `#ffffff` canvas/panel/input, `#141414` ink); Dark deepens
  into pure neutral charcoal (`#0d0d0d` shell → `#121212` sidebar → `#151515`
  canvas → `#1b1b1b` panel, `#fafafa` / `#d4d4d4` / `#9a9a9a` text). `my-app-window`
  and `my-shell-layout` paint the shell with shared inset/radius/border tokens.
  Utility-window roots do not acquire that frame.
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
- `Tooltip` also portals into the owning `.my-root` and positions with
  `position: fixed`, so page `overflow: hidden` bands and the `z-50` window
  header can never clip or cover it. It flips to the opposite side when the
  preferred side lacks viewport space and clamps into the viewport. It shows on
  hover and keyboard `:focus-visible` only, hides on trigger activation
  (pointerdown) until the pointer leaves, and dismisses on scroll, resize and
  Escape. Do not reintroduce pure-CSS absolute tooltips inside clipping page
  bands; wrap disabled buttons behind a tooltip with `.my-tooltip-anchor >
  button:disabled { pointer-events: none }` already handled globally.
- Page geometry lives in `my/layout/PageLayout.tsx`, with exactly two variants:
  `PageLayout({ variant: 'full'|'centered', ...divProps })`. The exhaustive
  `PAGE_LAYOUTS satisfies Record<Page, PageLayoutVariant>` registry classifies
  every route, including new routes. `PageFrame` consumes that registry; pages
  with their own module header compose the same layout directly.
- Settings destinations share `PageFrame`'s `.my-settings-layout`: a centered
  column using `--my-settings-content-width`, a PageBody scrollbar, and an icon,
  title and purpose description inside PageContent. `settings-catalog.ts` owns
  category names, descriptions, icons, keywords and routes for both the page
  heading and grouped Settings navigation. Do not add a competing leaf sidebar,
  duplicate title or scope badge. The model-provider page bounds its workspace
  and scrolls the provider list and model detail independently, so scrolling a
  long model list keeps the provider list visible. At narrow widths the provider
  list scrolls horizontally; short windows retain access to the page scrollbar.
  Keep `margin-inline: auto` and symmetric scrollbar gutters so the title and
  content column share the remaining main region's center. Settings canvas uses
  `--my-bg-sidebar`; `PreferenceSection` and its heading use `--my-bg-surface-1`
  and `--my-bg-surface-2` for a restrained surface contrast in both themes.
- `SettingsNavigation` filters category names and keywords without silently
  changing the active page. Clearing returns focus to search. Arrow/Home/End
  navigation moves button focus; Enter/Space activates the focused destination.
  Text input, IME and modified shortcuts retain their native behavior.
- Application Settings, including integration and MCP overviews, remain reachable
  without an open project. `pageRequiresProject` controls both the main fallback
  and title-bar search availability; project-specific actions keep their own guards.
- `PreferenceSection` and `PreferenceRow` in `pages/settings/` own Settings groups:
  one neutral panel contains its heading, trailing group action and divided rows.
  Primary labels and descriptions align on the left and controls on the right.
  Fields use `--my-settings-field-width`; narrow containers wrap fields while
  keeping simple toggles beside their labels. Use explicit input labels, named
  actions, actual state and existing focus/feedback primitives. Page switching
  must not hide usable settings behind an entrance animation.
  Row labels and hints consume the shared item title/description roles.
  `--my-settings-label-color` remains an alias of `--my-txt-item-title`.
  Preserve both weight and tone differences
  between names and descriptions rather than relying on a 1px size gap alone.
  Section headings use `--my-text-sm`, medium weight and primary text.
- Settings density is configurable. Compact uses a 20px page title, 12px primary
  labels, 11px descriptions, 32px navigation rows and 16px panel padding.
  Standard raises dimensions modestly; Comfortable is one small step above it. All roles
  come from the three token presets rather than browser zoom or CSS scaling.
  Single actions belong beside page or group identity instead of in standalone
  full-height panels. Empty recent-project data is one secondary line. At the
  user's 1360×862 CSS-pixel viewport, all three General switches and both shortcut
  fields must be visible without scrolling in all three presets. Verify at the
  actual device scale.
- Shared icon hover uses the independent CSS `scale` property and
  `--my-icon-hover-scale`, preserving icon rotation and loading animation.
  A specialized icon tile owns its own scale; do not also scale its inner SVG.
  Selected, disabled, expanded and busy controls remain stable. Reduced-motion
  mode removes nonessential spatial movement.
- Provider and engine overviews use compact identity rows with icons, truthful
  state and trailing actions. Open editing explicitly; provider draft changes
  require Save/Cancel rather than mutating credentials while typing. Shared
  Settings geometry does not require a persistent form for every object.
- `PreferenceRow.detail` spans the whole row below identity and actions. Put
  connection details there, never inside the trailing control column. Keep raw
  diagnostics available on demand; remove redundant explanatory prose.
- Engine Settings refreshes local installation inventory automatically while
  visible. Keep protocol testing and registry version checks manual. Normal
  refresh/test/install completion belongs in compact status/icons and accessible
  announcements, without permanent success paragraphs. Preserve actionable errors
  and actual diagnostics; parameter/environment configuration links to Agent roles.
  Engine rows show identity, one current status and the relevant primary action;
  secondary configuration and diagnostics are disclosed on demand. The connection
  diagram and row reflect the same operation. Use neutral verified marks and lines;
  where no real progress value exists, show indeterminate activity without a percentage.
- Model credentials belong to Models; knowledge connections and retained legacy
  synchronization controls belong to the WeKnora integration; MCP installation
  belongs to MCP. Keep active compatibility controls reachable in the owning
  destination instead of duplicating their editors in Preferences. About names
  this application, its package version, repository and license.
- `PageHeader`, `PageToolbar` and `PageNotice` provide fixed, aligned bands.
  `PageBody` fills the remaining height. A centered body owns one scrollbar;
  a full body delegates scrolling to its real workspace panes. Do not restore
  an additional scrolling wrapper around `PageBody` in `MyApp`.
  The full-width personal homepage is viewport-locked at desktop size:
  `PageBody.my-home-body` never scrolls; the greeting header and metric cards
  are fixed bands and the 9:3 task/record workspace fills the remaining height
  with one 12-column grid. `.my-home-task-rows` is the main column's single
  scroll owner and `.my-home-side-col` scrolls as one pane, both through the
  shared `my-scrollbar` role with stable gutters and contained overscroll.
  The two side cards share the column height with `flex: 1 0 auto`; each card's
  action area (quick-todo form, shortcuts grid) pins to its card bottom, and
  the column scrolls only when content exceeds it.
  Compact shells (the 960px container breakpoint) and short windows
  (≤620px viewport height) release the lock in `my-dashboard.css` and restore
  the `PageBody` page scroll. The homepage keeps global gutters and adds no
  private maximum width; its bottom inset is the block inset. The standalone
  onboarding screen stays centered.
  Framed dashboard routes (`team`, `analytics`, `devtools`) share the same
  viewport-lock through shell classes: `PageFrame` marks their `PageBody` with
  `my-locked-body`, the page root is a `my-locked-canvas` `PageContent` that
  fills the height, and each view owns one `my-locked-scroll` region (add the
  `my-scrollbar` role when that region is the scroll owner). Tool views
  (`GitViewer`, `ApplicationRuntimeView`) fill the region and pin their headers,
  owning their own scroll panes; `architecture` and `studio` already fill the
  body with their own pane chains. Short windows (≤620px viewport height)
  release every locked page to the `PageBody` scroll in `my-shell.css`.
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
- `BrandMark`, `BrandWordmark` and `BrandMotion` consume canonical Crux assets.
  Product activity uses the state and lifecycle contracts in [brand-system.md](./brand-system.md).

Example:

```tsx
<Button variant="primary" onClick={save}>保存</Button>
<input className="my-input" aria-label="名称" />
<div className="rounded-my-lg bg-my-layer-2 p-4 text-my-sm text-my-secondary" />
```

## Selection, hover and result presentation

- `DropdownItem({ selected?, icon?, ... })` owns the selected check and renders it
  at the trailing edge. Callers pass `selected`, not a leading Check component or
  an empty placeholder icon. Semantic icons (avatar, priority, file type) may stay
  at the leading edge; icon-free items begin directly with their label. The shared
  `Select` follows the same trailing-check convention. Table bulk-selection and
  form checkboxes retain their actual checkbox semantics.
- Menu captions use the shared `my-menu-header` role: `--my-menu-title-size`
  (`--my-text-xs`, standard12px), `--my-menu-title-color` (tertiary), medium weight
  and no option hover treatment. Options use `my-menu-item` / `my-select-option`:
  `--my-menu-option-size` (`--my-text-sm`, standard13px),
  `--my-menu-option-color` (primary), fixed `30px` row height and `0 8px` padding.
  Both scale through the same font preset; captions stay smaller (`12px` vs `13px`).
  Do not use secondary color and the same type size for both a caption and an enabled choice.
  Actual page/dialog headings and the selected strength value retain their own stronger heading/value roles.
  All vertical option containers (`my-menu`, `my-menu > .my-scrollbar`, `my-select-menu`,
  command lists and navigation sub-lists) must lay out options with
  `display: flex; flex-direction: column; gap: var(--my-space-2)` (2px) so
  selected, hovered and active pill backgrounds never collide edge-to-edge.
  `my-select-menu` uses `scrollbar-gutter: auto` and omits `my-fade-scroll` so short
  dropdowns do not wash out top/bottom items or reserve a blank trailing scrollbar column.
  `my-select-option` uses the same selected/hover background mixes as `my-menu-item`
  (`6%` hover / `10%` selected / `12%` active) so selected rows stay clearly
  distinguishable from hovered rows in both themes.
  Focus uses a 3-tier neutral hierarchy: frameless editors/composers and
  `.my-command-search` opt out of focus rings (`.my-focus-none` / `[data-focus-ring='none']`);
  `.my-input` and `.my-select-trigger` emphasize their existing 1px border
  (`--my-border-strong-1` + `--my-focus-shadow`) without heavy 2px outlines;
  and interactive controls/nav items show a restrained `--my-focus-width` (1.5px)
  `--my-focus-ring` only on `:focus-visible`.
- Custom navigation headers (such as the model chooser) compose `my-menu-header`
  rather than inventing a local text style. Keep back-control hit targets, but
  avoid excess leading padding/gaps that push the caption far right. Actions in
  the plus menu, including plan mode and expandable parameters, use the same
  option role. A short action label does not need a duplicate inline instruction.
- All placeholder consumers use `--my-txt-placeholder` with explicit opacity1.
  The palette defines light ink42% and dark white36%; pages must not stack extra
  opacity or hard-code a grey. The invitation is intentionally quieter than
  entered text, while labels and actual text keep their full readable roles.
  Renderer checks composite alpha against the real surface: menu title/option
  text must reach4.5:1, options must have stronger contrast, and placeholder
  contrast stays between2.2:1 and4.5:1 (separate from actual text).
- Ordinary controls share `--my-control-radius`, resolving to `--my-radius-base`
  at 10px. Button, icon button, menu option, Select and composer actions
  consume this semantic token. Hover, active, expanded and selected states keep
  the same base radius; do not introduce a page-specific 4px/6px hover corner or
  change geometry on hover. Cards and menu containers use the same 10px value;
  functional circular widgets retain their geometric shape.
- Enabled composer actions use the shared neutral hover surface and rounded hit
  area, including plus, session mode/permission, model, popup back and caption
  controls. Hover must not move adjacent controls; open/pressed and keyboard-focus
  feedback remain visible. Disabled controls do not acquire enabled hover states.
  Never apply a blanket background that overrides danger/filled/button variants.
- The shared model selection panel has a preferred width of 340px and opens
  above the composer with an 8px gap. Align its right edge to the composer right
  control group, including Send. Shared
  `Dropdown({ positionAnchorRef?, placement?: 'auto'|'top'|'bottom', gap? })`
  preserves the default auto/4px behavior for other callers. Use measured popup
  dimensions and the actual trigger bounds; negative trigger margins and entry
  animation transforms must not corrupt alignment. Clamp to 8px viewport gutters,
  shrinking to viewport width minus 16px where necessary.
- Model choices have one scroll owner, `.acp-unified-picker-content`.
  Keep search and applicable footer actions available as the results shrink.
  Place model-specific configuration after its model row inside the results.
  Let the category rail scroll if the available height cannot fit its controls.
  Use the shared popup bounds and keep selection, favorites and configuration
  independently focusable.
- The context ring has a quiet pale base (`--my-context-track`), never a dark
  full ring or a center minus that resembles “full/disabled”. Unknown reports use
  a static open outline and a `暂无数据` accessible description; a reported zero
  has a complete pale outline. Neither draws an active progress arc. Actual
  positive usage draws the proportional arc: neutral (`--my-context-used`) below
  75%, warning (`--my-context-warning`) from 75% and critical
  (`--my-context-critical`) from 90%. These are presentation thresholds, not
  runtime limits. Active arcs must contrast at least 3:1; the decorative base is
  deliberately lighter (renderer checks 1.3:1 to below 3:1). Keep the current
  connection/model ownership and exact reported percentage; never invent capacity
  or treat a missing report as zero. No spinning placeholder or center minus.
- Known native mode labels are localized for people, while IDs/capability checks
  remain untouched: `Read-only` → `只读`, `Workspace access` → `工作区访问`,
  `Auto review` → `自动审核`, `Full access` → `完全访问`. Recognize the same known
  labels with case/hyphen/underscore/spacing variation; preserve unknown custom
  names and never infer or broaden their permissions from translated wording.
- Consecutive, structured file-change facts use a single default-closed change
  group, with one row per actual path and real update counts. Preserve original
  events and scope boundaries; keep warnings/errors independently visible.
  Append updates without resetting the user's expansion state. Show concise
  source-relative names where supplied and keep exact identities accessible.
  Real view actions belong inside the expanded list; never invent undo or line
  statistics. A watcher event is a file fact, not proof the current Agent edited
  it or the user approved it.
- Default UI copy names the user's action or an actual state; do not stack
  implementation explanations, internal contracts or defensive caveats in menus,
  placeholders or conversation content. Put optional help behind a labelled info
  icon with hover/focus support or a deliberate disclosure. Keep failure and
  persistence facts discoverable and actionable. Use compact icon + status text
  for real loading/empty/error states. The composer invitation is
  `说说你的想法…` in ready, offline and busy states; connection state belongs to
  its status control. Model menus use the short `选择模型` title; saved-candidate
  validation belongs to recovery help, not a permanent second paragraph.
- Asynchronous conversation work has continuous, compact feedback from local
  submission until authoritative completion. Put one current-status affordance
  after the latest content, independent of recorded process rows; do not wait for
  the first token or leave silent gaps between phases. Use neutral theme roles
  and a reduced-motion-aware spinner for actual engine work, with nonspinning
  user-confirmation states. Do not invent progress percentages, saved events,
  phase transitions or elapsed times to fill a wait.
- Paging actions inside a transcript must look actionable: use a shared neutral
  icon button and a subtle horizontal boundary, with activity-sized text distinct
  from prose. Keep optional coverage metadata behind a labelled information
  disclosure, not a second ambiguous navigation label. Preserve semantic theme
  colors, shared hover radius, loading feedback and the reader's scroll anchor.
- Use `ActivityResult({ icon, title, description?, action?, tone? })` from
  `my/ActivityResult.tsx` for recorded Hook/project/file results. Its neutral full
  border and quiet icon tile align the content with a real action on the right.
  Long paths wrap, narrow layouts can wrap actions, and current font/theme roles
  are inherited. Only show actual operation outcomes: pending/failed edits cannot
  claim completion, file changes do not prove approval, and an injection receipt
  does not prove the model read or obeyed its contents. Do not fabricate Undo,
  change counts or View Changes without the corresponding data/action.
- **No colored left-edge borders or inset colored rails** on notices, result
  cards, errors, warnings, selected items or diff lines. Convey severity with the
  semantic icon/text and, when needed, a subtle surface. Keep frames neutral and
  uniform on all sides. Diff additions/removals retain +/- markers, line numbers
  and subtle row surfaces. Neutral structural pane separators and actual timeline
  connectors are separate layout roles, not severity decoration.

Verify in light/dark and narrow/font-scaled Chromium: label alignment without a
leading check gutter; exactly one trailing check; a subtle stable hover surface;
accessible disabled/selected/focus states; result title/action readability; no
colored left stripe. Run static `npm run check:ui`, typecheck/build and inspect affected consumers.

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

The persisted `small/standard/large` appearance values select Compact/Standard/
Comfortable density with 13/14/15px UI/document/chat text. Missing or invalid values
select Standard. Keep stored values, unrelated settings and
cross-window storage synchronization. Font controls remain in Settings only.
Metadata and activity use a smaller global text role. Heading line-height is1.2.
Changing type never changes reader/session identity. Chat uses the UI font-size
role (13/14/15px), 1.75 line height and the shared16px paragraph gap. Its light
ink96% / dark white92% foreground is the canonical `--my-txt-chat` token; do not
fade the entire Markdown container. Titles and strong emphasis retain their
primary text role. Chat lists use compact2px item gaps and4px inner-paragraph gaps,
with deliberate nested-list spacing; do not stack full prose paragraph margins
inside every list item. Document readers retain their own typography contract.
The toolbar uses `--my-shell-chrome-size` (44/48/50px by density). The module rail
is independent: width48/52/54px, target32/34/36px and glyph18/20/21px, with1.7
icon stroke. The header brand slot
shares rail width, not rail height; changing the rail must not raise the toolbar.
Rail geometry follows the selected density preset. Its buttons inherit the shared
control radius and existing neutral hover/selection colors. Short windows retain
an independently scrollable primary nav and reachable footer controls. Fields
and ordinary buttons use density-specific compact, regular and field height roles.

## 4. Interaction and validation matrix

| Case | Required result |
| --- | --- |
| Dark/light primary control | Correct inverse ink; normal text contrast at least 4.5:1 |
| Danger control | On-color text stays readable in every theme |
| Input/select | Same single-line height; textarea may grow |
| Keyboard focus | Neutral visible outline or token focus shadow |
| Text-field focus | One visible inset contour covering the existing border; error color survives hover and focus. Buttons and other controls retain visible keyboard outlines |
| Menu near viewport edge | Actual measured menu remains inside the viewport |
| Narrow dialog | Panel fits the viewport without a document horizontal scrollbar |
| Centered route | Header, scope note and body share1120px content width and the same gutter; body alone scrolls |
| Full route | Header stays fixed; tables/editors/panes fill the remaining space and retain their own scroll owners |
| Viewport-locked pages | Homepage, team, analytics and tools keep page-level scrollbars away at desktop size: fixed bands stay put and each workspace region owns its internal scrolling; a short window (≤620px height) restores `PageBody` scroll |
| Page migration | No old outer max-width or duplicate page padding; reader/session keys and interaction scopes are unchanged |
| Font/theme change | Drafts, reading state and existing choices stay intact |
| Transparent utility root | Canonical font/colors without an opaque root background |
| Reduced motion | Remove nonessential playback; transition-duration is0s |
| Text/code/message selection | Copyable content remains selectable |
| Conversation viewport | Hide only the transcript scrollbar chrome; retain overflow scrolling, keyboard/wheel access, reading anchors and centered composer alignment |

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

Run `npm run typecheck`, `npm run build` and `npm run check:ui`. The UI command performs static token, palette, brand and source-asset checks; it does not launch Electron or verify rendered geometry/focus.

Inspect actual shared primitives across light/dark and three font presets for contrast, focus, viewport-clamped menus, narrow dialogs and transparent utility roots. For composer changes, check settings/model widths, right-group alignment, the 8px gap, short/scrolling lists, 320/240px viewport clamping and unknown/zero/25%/75%/90%/100% usage. Verify localized modes, change-group folding, per-file deduplication and expansion retention on append. Disable transient menu motion for geometry captures and verify animation separately.

Exercise affected navigation, ACP and reader interactions. Keep native appearance mapping synchronized with `backend/window-appearance.md`. Browser captures do not establish Windows DWM/tray behavior; inspect actual screenshots including open states. Temporary scripts and captures belong in OS TEMP.

## 7. Wrong versus correct

Wrong: `bg-my-accent text-white` or a nested unconfigured `.my-root` in a document.

Correct: `bg-my-accent text-my-on-accent`, and a single App-owned typography root
with normal content wrappers inheriting its selected font scale.

## 8. Foreground and desktop notifications

### Scope / trigger

Use this contract for transient application feedback, task-material changes,
bridge messages, update availability and notifications while minimized or hidden.
Windows owns native notification chrome; CSS tokens apply to renderer surfaces.

### Signatures

- `ToastEvent`: `kind`, `title`, optional `body` and optional
  `task: { projectRoot: string; dirName: string }` navigation target.
- `formatMaterialToast(Pick<MaterialUpdatedEvent, 'title'|'count'|'files'>)` in
  `src/shared/notifications.ts` supplies identical concise foreground/native copy.
- `deliverToast(toast, mainWindow, onClick)` owns main-process delivery.
- `NotificationCard({ notification, onDismiss?, action?, onExpandedChange? })`
  and the App-owned `Toasts` host own renderer presentation and lifetime.

### Contracts

- A live, visible, focused, non-minimized main window receives one toast event.
  Otherwise use one silent native notification with the canonical application icon.
  Bridge notifications never force the window into focus. Do not pair delivery
  with a second toast broadcast or generate toast UI from `materialUpdated`.
  That domain broadcast remains available to conversation/material consumers.
- Native task clicks capture project root and generation; only a matching current
  project may receive the task focus. Renderer actions validate the current root
  again at click time and handle removed tasks visibly.
- Cards use `my-feedback.css` and canonical `--my-notification-*` geometry/stacking
  tokens, shared neutral layer/border/shadow roles, semantic icons and global
  font presets. Titles and descriptions have distinct type roles. Frames never
  carry severity color. Preserve shadow gutters and narrow/short viewport access.
- Clamp title/body to two lines at rest, offer expansion on measured overflow,
  and retain the full message in a bounded keyboard-scrollable expanded area.
  Closing has an accessible name; actions have hover/pressed/focus states.
- The toast slice retains at most three cards and coalesces exact duplicates,
  including their task identities. Mounted items own cancellable timers: 5 seconds
  for info/success, 9 seconds for warn/error. Hover, descendant focus, expansion
  and hidden documents pause dismissal; resuming gives a full reading interval.

### Validation / error matrix

| Condition | Expected result |
| --- | --- |
| Main focused | One renderer toast; no native notification |
| Minimized, hidden, unfocused or missing main | One native notification; no duplicate renderer toast |
| Native API unsupported or fails | Best-effort delivery; no application failure |
| Old native task click after root switch or A→B→A | Show main without focusing a stale task |
| Foreign renderer task target / removed task | Hide foreign action / show unavailable feedback |
| Long paths, large fonts or narrow window | Bounded card, recoverable full content, operable controls |
| Hover/focus/expansion/hidden document | No auto-dismiss until interaction ends |

### Good / base / bad cases

Good: a five-file task update shows the real count and two concise file names,
with a real task action. Base: a save result uses a short neutral card with a
success icon. Bad: long paths grow an unbounded card, or one event fires native
and renderer notifications together.

### Required checks

Run static `npm run check:ui`, typecheck/build and inspect notification/navigation interactions. Verify six theme/font combinations, clamping/expansion, viewport bounds, dismissal/pause/deduplication and task actions. Use OS TEMP for any scripted OS-boundary checks; simulated notifications do not prove Windows notification-center visuals.

### Wrong versus correct

Wrong: each producer constructs `new Notification` or broadcasts a toast and also
invokes native delivery. Correct: main producers call the common delivery route;
local operation results use the same renderer queue and themed card.

## 9. Zero layout shift & interactive hover contrast contract

1. **Interactive state must never shift width or height (Zero Layout Shift)**:
   - Never change `scrollbar-width`, `scrollbar-gutter`, `overflow`, `overflow-x` or `overflow-y` inside `:hover`, `:focus`, `:focus-within`, `:focus-visible` or `:active` rules (`npm run check:ui` statically rejects these).
   - Scroll containers whose content height can toggle across overflow boundaries (multi-tab inspectors, expandable accordions, dynamic filtered lists) must use `scrollbar-gutter: stable` together with a constant `6px` transparent `::-webkit-scrollbar` track (never toggling `scrollbar-width: none ↔ thin`) and reveal the thumb solely by changing `::-webkit-scrollbar-thumb` background color on hover. That guarantees 0px width shift both on hover and when switching between overflowing and non-overflowing tabs.
   - Inline click-to-edit controls (`.collab-inline-trigger` ↔ `.collab-inline-input`) must share identical `box-sizing: border-box`, fixed height, padding and `1px solid transparent` border at rest so toggling edit mode causes 0px shift on surrounding content.
   - Hover-revealed card actions must overlay via absolute positioning (with a matching surface fade gradient) instead of expanding/collapsing flex flow width.
2. **Single unified dropdown menu system & perceivable hover contrast**:
   - Every dropdown menu across the application (organization switcher, action menus, runtime picker, task menus) must reuse the single shared `.my-menu` / `.my-menu-item` / `.my-menu-header` / `.my-menu-divider` primitives (30px row height, `--my-menu-option-size`, 6px container padding, 2px row gap) rather than creating parallel menu stylesheets.
   - Never use `--my-bg-layer-2` alone as a hover surface inside `--my-bg-elevated` menus. `.my-menu-item` uses `color-mix(in oklab, var(--my-txt-primary) 9%, transparent)` on `:hover`, `8%` on selected (`12%` on selected `:hover`), `14%` on `:active`, and `color-mix(in oklab, var(--my-txt-danger-primary) 11%, transparent)` on danger `:hover`, with transparent rest backgrounds and `cursor: pointer`.
