# Crux brand system

## Scope

Product identity in desktop windows, startup and recovery, onboarding, Agent activity,
team Web and generated platform icons. Provider logos, business icons, known progress
and operation-specific actions retain their existing meaning.

## Component signatures

- `BrandMark({ size?, className? })`: static, decorative, canonical mark. Numeric
  sizes and CSS lengths support density tokens without measuring the DOM.
- `BrandWordmark({ width?, className? })`: static vector Crux wordmark.
- `BrandMotion({ state, size?, active?, className?, label? })`: states are
  `observe | c | loading | waiting`; a stable square slot keeps adjacent text fixed.
  Without a label the art is decorative. The owning status supplies live semantics.
- `AgentActivityMark({ phase?, size?, active?, className? })`: projects existing
  current-turn phases to brand visuals and respects `useInteractionActive()`.
  Conversation activity defaults to a 16px optical mark inside a stable slot;
  do not enlarge the art to enlarge an interaction target. Current private
  activity stays at the transcript tail; recorded process types remain static.

## Source and state contracts

- `resources/brand/geometry.json` owns persistent pixels and component membership;
  `wordmark.svg` owns the vector wordmark. Production code imports these assets,
  never files from `crux-concept/` or the concept viewer's simulation engine.
- Static marks have no subscriptions, timers or animation loops. Small marks use
  the generated optical variant; inspect the actual destination size and device scale.
- Observation has two vertical pixel pairs. Both pixels in each eye move together.
  The C pose uses the canonical target map.
- Loading has four fixed parents in a 2×2 arrangement. Each parent contains four
  visible square children. Brightness travels NW → NE → SE → SW; the glyph does not rotate.
- Waiting has four parents in a horizontal row. Each parent's four children jump
  together, in order 1 → 2 → 3 → 4, landing before the next parent rises.
- Looping motion changes parent `transform` or `opacity`. State changes can update
  finite geometry transforms. React does not update on each animation frame.
- Pause motion for inactive retained sources, offscreen art and hidden documents.
  Reduced motion displays the selected static pose. Unmount releases observation
  and listeners; rapid state changes use the current visual pose.
- Status facts remain owned by the existing activity projector. Permission, retry,
  failed and completed states keep their semantic symbols and accurate labels.
- Startup art cannot grant readiness, hold the App for a minimum duration or delay
  receipt delivery. Keep the busy visual separate from the live status and preserve
  the existing cover/readiness/inert handoff in `daemon-bootstrap.md`.
- Startup keeps observation visible until real primary content is ready. Its finite
  handoff measures the central source and the title-bar destination, then moves and
  scales the source linearly before a small elastic dock. The cover fades separately;
  the final optical mark takes over without a duplicate or missing logo.

## Validation matrix

| Condition | Required result |
| --- | --- |
| Light/dark, small/standard/large density | Inherited ink, readable shape, stable slot |
| Small icon, 1×/higher DPI | Clear outline and eyes; no clipped art or stretched squares |
| Loading cycle | Four parents, 16 visible children, fixed centers, clockwise brightness |
| Waiting cycle | Four groups in a row, one airborne group at most, sequential landings |
| Waiting/loading/observation/C switch | No text displacement, ghost pixels or queued animation |
| Reduced motion or inactive source | Correct static pose and no running brand animation |
| Offscreen, display:none, hidden document | Local motion paused; task execution unchanged |
| StrictMode/unmount | No retained observer targets or duplicate global listeners |
| Startup ready/error/retry | Existing readiness and recovery actions remain authoritative |

## Usage

Use `BrandMark` for a navigation identity and `BrandWordmark` for a brand lockup.
Use `AgentActivityMark` beside an existing truthful Agent status. Ordinary local
save/upload/pagination controls keep their compact operation feedback.

## Required checks

Run `npm run check:ui`, `npm run typecheck`, `npm run build`, plus team Web typecheck
and build. Validate generated asset consistency and inspect actual sizes, both themes,
all density presets, reduced motion, visibility and lifecycle cleanup. Keep fixtures,
scripts, captures and validation reports in OS TEMP. Browser evidence does not prove
Windows taskbar, notification or installed-executable appearance.

## Incorrect and correct

Incorrect: apply `acp-progress-spinner` to the grouped loader or run a separate
spring/React update loop for every conversation row.

Correct: pass the actual phase to the shared component and animate only its parent
groups while visible. Business completion never waits for a brand animation.
