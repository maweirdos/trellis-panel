# Component Guidelines

> Semantic HTML, empty states, and scrollbar patterns.

设计或调整组件前，先读 [前端视觉与交互设计规范](./design-principles.md)。优先通过控件、布局和状态反馈表达操作关系；新增解释性文案须有明确的用户决策用途。加载、空状态、异常恢复、键盘焦点和减弱动态效果应作为组件的一部分设计，并在实际使用流程中验收。

---

## Text selection and copy

Page and dialog text is selectable by default, including errors, labels, code,
Markdown table headers and floating-window content. Do not apply user-select:none
to body, application roots or modal containers. Keep exclusions local to actual
drag handles, decorative icons and line-number gutters.

Shared window setup exposes native Copy/Select All and editable-field actions
using Electron's actual edit flags.

## Feedback and recovery

Choose a surface from the affected scope, how long the user needs the message,
and whether work requires an explicit decision.

| Trigger | Shared surface | Behavior |
| --- | --- | --- |
| Field validation | Text beside the field | Associate it through `aria-describedby` and `aria-invalid`. Preserve the value and focus the first invalid field on submit. |
| Recorded failure in a conversation | `FeedbackNotice variant="inline"` at the event | Show a semantic icon and a short outcome. The title row opens details and reveals diagnostic copy. Without details, show a static status. |
| Operation failure or ongoing degradation | `FeedbackNotice` beside the action, optionally inside `PageNotice` | Use `compact` in a constrained composer strip and `card` for a broader section error. Keep applicable recovery actions visible while the condition persists. |
| A page becomes unusable | `ErrorBoundary` with `FeedbackNotice` in the affected area | Keep the available shell and navigation. Retry render failures in place. For rejected lazy loading, reload the renderer document on user action. |
| Authorization, destructive confirmation, or discarding unsaved work | `Modal` / `DialogHost` | Capture an explicit decision. Errors from work inside a modal stay in that modal. |
| A short result independent of further action | `Toasts` / `NotificationCard`, or feedback at the triggering control | Use the existing queue or local receipt after the outcome is confirmed. Follow the [toast lifecycle](./css-design.md#8-foreground-and-desktop-notifications). |
| Searchable choice near its trigger | `Dropdown` | Keep the choice and the relevant loading, empty, or failed state in the same nonmodal panel. |

`FeedbackNotice` takes a short `title`, optional `description`, `diagnostic`, and
`actions`. Use a semantic icon, a neutral frame for cards, and a transparent
status row for `inline`. Pass supporting content such as recorded duration
through `details` on the inline variant. Keep the disclosure keyboard operable
with a visible focus ring and an arrow that indicates its state in reduced
motion. Show available recovery actions directly. Default diagnostics to
collapsed and keep the same bounded, redacted text available for selection and
copying. Use `CopyableError({ message,
summary? })` for upstream failures that just need a heading and diagnostic.
Set `announcement={false}` for recorded failures that are already in history.
Emit one primary notice for an operation. Keep separate incidents with different
owners independently actionable.

Pass an analyzable dynamic import closure to `lazyPage` when a route should
distinguish module-load failure. React keeps a rejected lazy payload even after
the boundary state resets. Fall back locally, retain draft recovery and startup
readiness, and make reloading explicit. Validate both a real rejected import
and a recoverable render error by clicking their actions. The conversation
workspace flushes local draft state synchronously on `pagehide`. Native creation
requires a live renderer that can record its acknowledged conversation identity.

## Shared choices and recorded results

Follow [CSS/design contracts](./css-design.md#selection-hover-and-result-presentation)
when adding or changing choices, composer buttons and Hook/file-result feedback.
Use `DropdownItem.selected` for the single right-side check, `DropdownItem.icon`
for leading icons/avatars/badges, and `DropdownItem.trailing` for trailing status
copy; do not reserve an empty leading check slot, and never place leading icons
or a second `<Check />` inside `DropdownItem` `children` (which renders inside a
single-line `truncate` span and will misalign or double-render checks). Keep
conditional trailing `<DropdownDivider />` elements inside the same condition so
menus never end with a stray line.

```tsx
// Good - icon slot, plain text label, and single component-owned check
<DropdownItem icon={<OrgIdentityIcon name={label} />} selected={isCurrent} onClick={onSelect}>
  {label}
</DropdownItem>

// Bad - icon and duplicate Check inside truncated children span
<DropdownItem selected={isCurrent} onClick={onSelect}>
  <OrgIdentityIcon name={label} />
  <span>{label}</span>
  {isCurrent && <Check size={13} />}
</DropdownItem>
```

Give enabled compact actions neutral rounded hover feedback.
`ActivityResult` owns icon/content/trailing-action geometry; compose real actions
without nested buttons or invented undo/completion facts. Severity never uses a
colored left-edge border. Keep focus and disabled behavior accessible.

## Desktop overlay ownership

Use `Modal` from `my/ui.tsx` for modal tasks, including command palettes and
imperative confirmations. It owns the themed portal, background isolation,
focus containment/return, central Escape registration and dual-state enter/exit
presence (`usePresence` in `my/motion.ts`). Closing immediately releases the
Escape layer, background `inert` isolation and focus return without waiting for
the `115ms` exit animation. **Never short-circuit `if (!open) return null` above
`<Modal>`** (which bypasses the `115ms` exit animation): either render `<Modal
open={open}>` directly or retain the outer wrapper via `usePresence(open,
MOTION_EXIT_MS)` while keeping the closing state read-only. All overlay enter
animations must end at `transform: none` so Windows ClearType text stays sharp.
A queued successor in `DialogHost` uses its request ID as the Modal key so
Escape rearms. Nested and sibling confirmations must leave only the top modal
interactive.

`Dropdown` owns portal positioning, focus entry/return, keyboard option
navigation and directional enter/exit presence (`110ms` exit while holding its
last measured coordinates). Pass `aria-expanded={open}` to dropdown triggers so
buttons show expanded anchoring while open, and do not pair `<Tooltip>` with a
native `title` attribute on the same button. Keep embedded text fields' editing
keys and composition intact; custom form content does not acquire menu semantics.
`Select` reuses this ownership and supplies listbox semantics, selected focus
and typeahead. `Tooltip` adds a `160ms` hover entry debounce (instant within
`450ms` across adjacent controls) and `95ms` directional exit.

Collapsible side panels (`ContextRegion` on the left, `ConversationRightPanel`'s
`.conversation-right-region` on the right) use persistent CSS Grid track
transitions (`grid-template-columns: 0px ↔ target width`, `200ms`) with a fixed
inner panel width, `inert` + `InteractionScope` isolation when collapsed, and
`usePresence` retention during collapse so content never reflows mid-transition.
In-page vertical disclosures use `<DisclosureGrid>` (`0fr ↔ 1fr`, `180ms`,
single `<ChevronRight>` rotating `90deg`, with `animated={false}` above 40 rows).
`Tabs` and `Segmented` in `my/ui.tsx` render a measured sliding pill indicator
(`.my-tabs-indicator` / `.my-segmented-indicator`) tracked by `ResizeObserver`.

Form drafts only set `hasDraft` while at least one field differs from its
effective initial value (reverting back to empty clears the dirty state).
Non-destructive close (`取消`/`Esc`) retains drafts silently; explicit destructive
discard (`放弃草稿`) executes immediately with a 5–8s Undo Toast scoped to the
same authority. Disabled primary submit controls and intercepted submit
shortcuts (`Ctrl+Enter`/`⌘Enter`) must state the exact blocking reason and
nudge/focus the first missing required field (`aria-invalid`).

`useCopyFeedback(ownerKey)` returns `status` (`idle`, `copying`, `copied`, `error`)
and `copy(text)`. Pass the displayed source's stable identity. Success follows
clipboard completion and clears after 2500ms; failure remains actionable.
Changing the owner, suspending the scope or unmounting invalidates pending
feedback without claiming that the operating-system write was cancelled.

`usePointerResize({ axis, direction?, enabled?, owner?, getValue, onChange,
onCancel })` returns `resizing` and pointer bindings. Pointer-up commits;
Escape, pointer cancellation, lost capture, window blur, hidden scope and
unmount restore the drag's original value and release capture. The cancellation
callback must still target the original owner. Keep keyboard resizing on the
separator and disable size transitions during the drag.

## Semantic HTML

Use proper HTML elements for accessibility and native browser behavior:

```tsx
// Good
<button onClick={handleClick}>Click me</button>

// Bad
<div role="button" onClick={handleClick}>Click me</div>
```

### Cards with secondary actions

Do not make a whole card a keyboard button when the card contains another
interactive control. That pattern creates competing focus targets and makes
Enter/Space behavior depend on propagation. Use an ordinary container with a
dedicated title or primary-action button and place expand, delete, snooze, or
other controls beside it as siblings:

```tsx
// Good - title and secondary action are sibling controls
<div className="card">
  <button type="button" onClick={() => onClick(item)}>{item.title}</button>
  <button type="button" onClick={() => onDelete(item.id)}>Delete</button>
</div>
```

Use `div role="button"` only for a surface with no nested interactive
controls, and only when a native button cannot express the required layout.

---

## Empty State Visual Centering

Use the shared `EmptyState` primitive from `src/renderer/src/my/ui.tsx` (backed by
`.my-empty-state` and `.my-empty-state--compact` in `my-components.css`), which
already handles optical vertical centering and balanced copy width. Avoid ad-hoc
negative-margin wrappers (`-mt-24`) unless a custom canvas cannot host `EmptyState`.

---

## Preventing Scrollbar Layout Shift & Auto-Hide

Use the shared `.my-scrollbar` (or `.collab-scroll`) class instead of writing
custom `::-webkit-scrollbar` blocks or raw `hsl()` / `border-radius: 5px` rules
(which fail `check:ui` token/radius checks).

- `.my-scrollbar` provides `scrollbar-gutter: stable` with a constant `6px`
  transparent track and auto-revealing neutral thumbs driven purely by changing
  `::-webkit-scrollbar-thumb` background color (`--my-scrollbar-thumb*` and
  `--my-radius-full`).
- Never toggle `scrollbar-width`, `scrollbar-gutter`, `overflow`, `overflow-x`
  or `overflow-y` inside `:hover`, `:focus`, `:focus-within`, `:focus-visible`
  or `:active` (`npm run check:ui` statically rejects these). In particular,
  avoid `scrollbar-width: none` → `:hover { scrollbar-width: thin }`, which
  causes Chromium on Windows to drop `::-webkit-scrollbar` and jump width.
- Short popovers and narrow icon rails (`.my-menu`, `.my-select-menu`,
  `.my-module-rail > nav`) explicitly set `scrollbar-gutter: auto` so compact
  containers do not reserve a blank trailing scrollbar column.

---

## Unified Dropdown Menus (`ActionMenu` & `.my-menu-*`)

All overflow ("More"), context, organization switcher, runtime picker and task
action menus must reuse the single shared `.my-menu` / `.my-menu-item` /
`.my-menu-header` / `.my-menu-divider` primitives rather than defining parallel
menu styles.

- Use `<ActionMenu>` (`src/renderer/src/crux/ActionMenu.tsx`) or `<Dropdown>`
  (`src/renderer/src/components/Dropdown.tsx`) for action menus, and `<Select>`
  (`src/renderer/src/components/Select.tsx`) for value selection. Never use bare
  HTML `<select>` (rejected by `check:ui`).
- Menu rows share `30px` height, `0 8px` padding, `2px` (`--my-space-2`) gap,
  `cursor: pointer`, trailing check for `selected`, and perceivable Oklab hover
  mixes (`9%` neutral / `11%` danger on `--my-bg-elevated`).

---

## Modal Form Visual Hierarchy & Indentation

Centered creation and assignment modals (Create Agent, Create Task, Create Team)
should read cleanly from top to bottom and fit within a single viewport without
vertical scrollbars whenever possible:

| Role | Font Size | Weight | Color Token | Geometry |
| --- | --- | --- | --- | --- |
| Modal title | `15px` | `600` | `--my-txt-primary` | `24px` horizontal modal inset |
| Field label | `12px` | `500` | `--my-txt-secondary` | `padding-left: 2px`, `6px` above control |
| Control value | `13px` | `400/500` | `--my-txt-primary` | Canonical `10px` radius (`rounded-my-base`) |
| Helper / hint | `11px` | `400` | `--my-txt-tertiary` | Below control, muted |

- Maintain `14px` vertical spacing between field groups and `12px` gap between
  two-column fields.
- Collapse optional long-text fields (such as custom instructions or detailed
  descriptions) behind an inline toggle by default so core required inputs remain
  visible above the fold without triggering modal scrollbars.

---

## Drag and Drop (Tree Structures)

When implementing drag-and-drop for tree structures, use a library like `@dnd-kit`.

### Library Choice

Use **@dnd-kit** instead of `react-beautiful-dnd` (deprecated) because:

- Active maintenance and modern React support
- Official tree example for nested structures
- Better TypeScript support
- Modular architecture

### Architecture

```
components/dnd/
├── index.ts              # Public exports
├── tree-dnd-utils.ts     # Tree flattening & validation utilities
├── SortableTree.tsx      # DndContext wrapper component
├── SortableTreeItem.tsx  # Individual draggable tree item
└── TreeItemOverlay.tsx   # Drag preview overlay
```

### Key Concepts

#### 1. Tree Flattening

dnd-kit's `SortableContext` works best with flat lists. Flatten the tree while preserving hierarchy via `ancestorIds`:

```tsx
interface FlattenedTreeItem {
  node: TreeNode;
  depth: number;
  ancestorIds: string[]; // For circular reference prevention
  parentId: string | null;
  index: number;
}
```

#### 2. Drop Position Detection

For folders, divide the element into three zones:

- Top 20%: Drop "before" (as sibling above)
- Middle 60%: Drop "inside" (as child)
- Bottom 20%: Drop "after" (as sibling below)

For items (non-containers), it's simply top/bottom 50%.

#### 3. Validation Rules

- Cannot drop on itself
- Cannot drop into own descendants (circular reference)
- Cannot drop inside non-container items
- Cannot drag non-moveable items (system items)

### Basic Usage

```tsx
import { SortableTree } from './components/dnd';

<SortableTree
  nodes={treeNodes}
  expandedIds={expandedIds}
  onToggle={handleToggle}
  onNodeClick={handleNodeClick}
  onMoveNode={async (nodeId, nodeType, newParentId, newParentPath) => {
    // Call API to update parent
    await api.updateNode({ nodeId, parentId: newParentId });
  }}
  rootPath="/root"
  rootEntityId={rootId}
/>;
```

---

## Focus Management

Transient comparison, preview, and review surfaces must return focus to the
control that opened them when they close. Store the actual triggering element
for the current interaction and restore it on the next animation frame only
after the surface has unmounted. Do not guess a selector or move focus to the
page heading; if the trigger was removed or is disabled, leave focus under the
browser's normal order.

### Focus Ring

Follow the shared 3-tier neutral focus hierarchy defined in `my-components.css`
and `DESIGN.md` rather than raw `2px` colored outlines:

- **L1 (Frameless inputs/composers)**: opt out of outer focus rings via
  `.my-focus-none` or `data-focus-ring="none"`.
- **L2 (`.my-input`, `.my-select-trigger`)**: emphasize the existing `1px` border
  with `--my-border-strong-1` and `--my-focus-shadow`.
- **L3 (Buttons, nav items, switches, menu items)**: render a restrained
  `--my-focus-width` (`1.5px`) `--my-focus-ring` outline on `:focus-visible` only.

### Focus Trapping

For modals and dialogs, trap focus within the container:

```tsx
import { useRef, useEffect } from 'react';

function useFocusTrap<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const focusableElements = element.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    const firstElement = focusableElements[0] as HTMLElement;
    const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };

    element.addEventListener('keydown', handleKeyDown);
    firstElement?.focus();

    return () => element.removeEventListener('keydown', handleKeyDown);
  }, []);

  return ref;
}
```

---

## Loading States

### Route & Lazy Module Loading

Do not flash white screens or instant full-page spinners when switching between desktop modules:

- Register lazy route modules in `src/renderer/src/my/layout/page-registry.ts` so `scheduleCorePagePreload()` warms core routes during idle time and rail buttons prefetch chunks on pointer hover / keyboard focus.
- While a cold route chunk is still loading, `MyApp` keeps the previous committed route visible and reveals only the top `2px` neutral `.my-route-pending-bar` after a `160ms` threshold.
- Use `src/renderer/src/my/layout/PageLoading.tsx` as the `Suspense` fallback; its `.my-page-loading-indicator` delays visual reveal by `140ms` so fast cached chunks never flash a loading state.
- For pages with asynchronous snapshot reads (such as `integrations`), cache the latest snapshot per canonical project root so returning to the tab renders cached data immediately while refreshing quietly in the background.

### Inline Skeleton & Busy Controls

When an in-page region is awaiting initial data, use design-system surface tokens (`bg-layer-2` / `rounded-my-base`) rather than undefined utility classes like `bg-muted`, and avoid raw English `Loading...` text in Chinese user-facing surfaces. Keep button widths stable while busy (`aria-busy` + `disabled` + semantic spinner + clear Chinese action label such as `保存中…`).

---

## Global Command Palette (`CommandPaletteSurface`)

Both the global `Ctrl+K` palette (`src/renderer/src/my/CommandPalette.tsx`) and the collaboration workspace palette (`src/renderer/src/crux/CruxCommandPalette.tsx`) must render through the shared `CommandPaletteSurface` primitive (`src/renderer/src/my/CommandPaletteSurface.tsx`) rather than maintaining parallel modal markups or key handlers.

- Always delegate visibility to `<Modal open={open} bare>` so `usePresence` exit animations (`115ms`) run intact; never short-circuit `if (!open) return null` outside `<Modal>`.
- Provide category filtering via shared `Tabs` (`.my-tabs-indicator` spring pill), inline entity drill-down chips (`Tab` to enter entity actions, `Backspace` on empty query or first `Esc` to pop back, second `Esc` to close), IME composition guards on all key handlers, trailing active-row action verbs, and a compact `.my-kbd` shortcut footer.
- Render structured entity previews in a detached right-side `.my-command-preview` card (`268px`, hidden `< 900px`) with `70ms` selection debounce, `130ms` `backwards` focus-fade ending strictly at `transform: none; filter: none`, and `ResizeObserver`-driven `170ms` results-container height morphing (disabled under `prefers-reduced-motion: reduce`).

---

## Quick Reference

| Pattern                    | When to Use                 |
| -------------------------- | --------------------------- |
| `role="button"` + tabIndex | A surface with no nested interactive controls when a native button cannot express the layout |
| `EmptyState` / `.my-empty-state` | Optical centering for empty panes |
| `.my-scrollbar` (`scrollbar-gutter: stable`) | Prevent layout shift on scrolling regions (`auto` on compact popovers/rails) |
| `DropdownItem.icon` + `selected` | Leading icon/badge alignment and single trailing check |
| `CommandPaletteSurface` | Global (`Ctrl+K`) and workspace command palettes with category tabs, drill-down chips and floating preview cards |
| `usePresence` (`my/motion.ts`) | Dual-state enter/exit transitions for modals, menus, tooltips, drawers and collapsible panes |
| `page-registry.ts` + `PageLoading` | Prefetched lazy routes with `160ms` top pending bar and `140ms` delayed fallback |
| Toast notifications        | User feedback with `2px` pause-synced countdown and `.my-toast-slot` fold collapse |
| Focus trap                 | Modals/dialogs              |

---

**Language**: All documentation must be written in **English**.

## Markdown links and render recovery

MarkdownView owns external-link click/auxiliary-click routing. Valid absolute
HTTP(S) URLs use the existing main-process `openExternal` bridge to the system
browser. Preserve native same-document heading/footnote anchors and copyable
hrefs. Supported local document links use the separate `openLocalDocument`
bridge, including project-root-relative documents and native `/C:/...html`
paths. Main authorizes them; renderer normalization is not permission. Absolute
local hrefs must remain copyable `file:///` URLs. Local-document capability and
opener failures are visible, with full-restart guidance for old preload. See the
[local document contract](../backend/local-document-links.md).
Malformed and unsupported schemes must not navigate the app; keep sanitization
enabled. Never use a bare external anchor that replaces the
frameless application, or construct an unclosable embedded browser surface.

The main-window navigation boundary is independently required for every app
window, including documents, capsule and quick todo. Renderer prevention alone
does not protect plain anchors, redirects or `window.open`.

## Retained Markdown component identities

When a retained reader consumes InteractionScope or guarded document/image link
context, context updates can rerender even a React.memo wrapper. ReactMarkdown
component functions for headings, anchors, code and tables must retain their type
identity while unchanged content stays mounted. Do not recreate render component
factories on every interaction-signal change: that replaces descendant DOM and
loses the user's selection/reading position.

Keep stable renderer mappings and route mutable guarded link callbacks through
latest refs/context. Stability must not retain obsolete authorization, source
callbacks or KnowledgeDocument asset scope. Scope suspension invalidates pending
action tickets and transient error/busy state, not the displayed source body.

Verify the same heading DOM node, selected text and scroll across suspension;
also change the source callback and verify a stable anchor uses the new guarded
handler. See backend/workflow-reading.md and verify the actual reading-window renderer.

