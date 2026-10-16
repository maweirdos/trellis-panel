# Desktop chrome refinement — 2026-10-16

Scope: renderer chrome only, following the user's Codex reference and rejection of the first shell. Existing work and all navigation/workflow contracts are retained. Native outer-frame investigation belongs to the main coordinator.

## Changes

- `components/TitleBar.tsx`: keep the 48px shared desktop/preview header and native drag/no-drag boundaries. Align the 22px leaf mark with the fixed rail; remove the extra project/collapse separator. Replace the bordered search field with a quiet command action and readable shortcut. Keep all native controls and subscriptions unchanged.
- `my/layout/ProjectSwitcher.tsx`: replace the boxed field and leading folder with a 16px semibold project title plus a quiet chevron. Transparent at rest, soft hover/open feedback, existing keyboard ring retained. The real-root menu now uses readable name/path rows, neutral selection and a restrained green current-project check. Canonical-root no-op, disabled browser opening, recent projects and error messages are unchanged.
- `my/layout/WorkspaceSidebar.tsx`: retain eight fixed peer modules and bottom settings/user actions. Use consistent 22px icons, 40px targets and 8px spacing, without 10px captions. Full accessible names and native hover labels remain on every module. Use a neutral selected shape instead of a green tile/side stripe. Context rows use 14px labels, 16px icons, at least 36px height and soft selection; keep all existing view/favorite actions and routes.
- `my/my.css`: remove project field border, module selection stripe, and context row borders/shadows. Keep generated semantic tokens and global keyboard focus. The rail hides its scrollbar gutter so icons align with the header mark, while remaining scrollable. Context width is 224px, reduced to 200px below 1100px; no new color palette was introduced.

## Checks

- `npm run typecheck`: passed.
- `node scripts/smoke/navigation.mjs`: passed (17 routes, root scope/isolation, initial focus, transitions and recent-project races).
- `npm run build`: passed. Existing npm-config, module-type and ineffective dynamic-import warnings remain.
- `python .trellis/tasks/10-15-unify-plane-uiux/check_my_classes.py`: passed, 88 used classes and zero missing.
- `git diff --check` for changed tracked chrome files: passed.

These checks establish compilation and retained navigation contracts, not visual acceptance. The main coordinator is capturing light/dark, 960/1440px, menu/focus and native-frame evidence separately. No commit or staging was performed.

Baseline: `C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a1436e-1074-7543-b63b-a091acb889ed/uiux-polish-baseline`.
