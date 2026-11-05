<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

# Local verification

- Keep project-owned test code, fixtures, mocks, snapshots and validation reports local-only. Do not stage, commit or force-add these assets.
- Put temporary validation scripts and artifacts in the operating system's TEMP directory outside the repository. Do not introduce tracked test runners, CI test jobs or test-only dependencies.
- Preserve production checks and lifecycle guards: `check:acpx`, `check:ui`, `typecheck`, `build`, `postinstall`, and the existing dev/build/typecheck/packaging guards. Run applicable production checks and report their results.
- Do not change global Git configuration or Git hooks to enforce these rules.

# UI design standard

- Use the current Settings interface as the visual baseline for application pages. Before designing or editing UI, read `PRODUCT.md` for users, purpose and constraints, then `DESIGN.md`, `.trellis/spec/frontend/css-design.md` and the relevant domain guidelines; reuse the shared components and tokens.
- Design for clarity and simplicity matching Linear and Apple Notes standards: single clear purpose, minimal architecture, restrained design, and simple direct implementation.
- Omit slogans, secondary auxiliary text, and redundant explanatory tags or count badges. Let layout structure and spatial relationships convey purpose. If a view requires auxiliary copy to make sense, refactor the layout instead of adding explanatory labels.
- Every interface decision must simultaneously improve User Experience (UX), Developer Experience (DX), and Agent Experience (AX) without breaking existing behaviors, accessibility, or type safety.
- Input and toolbar action controls (such as send and stop) display icons directly without outline borders, filled frames, or box wrappers. Selector triggers display the target item directly, omitting vendor or provider prefixes.
- Ordinary rectangular surfaces and controls use `--my-radius-base` at 10 CSS px in every density preset. Do not introduce local radius values or spacing-derived offsets. Functional circles and tracks retain `full`/`round`; joined edges and fullscreen surfaces may use zero.
- Use `my-item-title` and `my-item-description` for ordinary names and supporting descriptions. Keep page headings, reading content, numeric data and status information in their own roles. Title styling must not leak into editable content or control values.
- Check actual rendered output in both themes and the three density presets. Preserve keyboard focus, restrained icon hover and reduced-motion behavior.
