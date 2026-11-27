# Editor and coding-tool brand icons

Read when displaying an editor/runtime/native-session identity. Semantic actions, task priorities and workflow states continue to use the existing Lucide system.

## API and identity

`src/shared/tool-brands.ts` owns `TOOL_BRANDS`, `ToolBrandId` and `getToolBrand(brand)`. Lookup is case-normalized with explicit aliases only. Do not infer brands from a session/task title, arbitrary substring, provider or executable path. The registry is presentation metadata; it does not register ACP adapters, discover native history or grant navigation capabilities.

`src/renderer/src/components/ToolBrandIcon.tsx` renders `ToolBrandIcon({brand,size=16,className})`. It is decorative and square; adjacent text/the containing control owns the accessible name. An unknown brand gets a neutral mark. Unbound tasks and panel actions retain their semantic icons, never a guessed editor logo.

Known products use actual local artwork. The initial catalog contains 49 product identities and 70 explicit aliases, backed by 44 SVGs and 5 PNGs. The exact coverage is in the registry and asset README; it is not a claim to exhaust every market product. Unverified brands remain neutral until a genuine source is obtained.

## Color and layout

Preserve original colored artwork in `image` mode. Use controlled `currentColor` masks for selected monochrome artwork so it follows the app theme. Do not globally gray/filter colored images, invent a green default, or tint one product to imitate another. Colored official marks (such as Codex's blue-indigo gradient SVG, Claude Code, ZCode and other colored assets) render in `image` mode to preserve brand fidelity; monochrome marks (such as Cursor) use `mask` mode so they adapt cleanly to light and dark surfaces.

Static imports are required; no render-time CDN requests or dynamic URL from user data. Keep object-fit/mask contain in the existing square slot. The homepage entry remains 220×28 with unchanged source/text/trailing-action alignment, global control radius, task/status/priority and click ownership. Native source/destination text should not repeat the same brand name; retain meaningful terminal/workspace information.

Use `ToolBrandIcon` consistently across homepage native entries, association candidates/linked relationships, RuntimePicker/RuntimeMark and RuntimePanel. For collaboration, IM and external integration marks (`feishu`, `dingtalk`, `wecom`, `wechat`, `slack`, `weknora`, `github`, `gitlab`, `jira`, `gitee`), use the shared `AppBrandIcon` (`src/renderer/src/crux/AppBrandIcon.tsx`) backed by local assets under `src/renderer/src/assets/app-brands/`. In summary rows, inspector headers and pickers, prefer real brand marks over verbose text badges or ad-hoc letter circles; avoid new per-page brand maps.

## Provenance and distribution

Artwork and source records live in `src/renderer/src/assets/tool-brands/`: pinned repository revision or retrieval date, SHA-256, source path/URL, license status and original notices. Do not replace a dedicated product mark with a different company/model mark. Preserve the distinction between GitHub Copilot and Microsoft Copilot.

Distribute the matching licenses, notices and provenance through `resources/licenses/tool-brands/`, which is included by the existing package resource glob. Keep the Kimi NOTICE. Some official website assets have no stated open license; preserve that fact instead of describing the entire catalog as MIT. Updating art or its attribution requires updating the distributed declaration copies as well.

## Checks

Run `npm run typecheck`, `npm run build` and static `npm run check:ui`. Verify aliases, source identity/hash/provenance, SVG safety, offline decoding and packaged asset declarations. Inspect actual 16/32 square slots, light/dark colors, neutral unknowns, source deduplication, global radii and click/refresh ownership using real SVG/PNG assets and component styles. Temporary validation scripts and captures belong in OS TEMP.
