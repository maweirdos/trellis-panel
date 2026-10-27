# Distributed tool brand notices

This directory accompanies the locally bundled editor/coding-agent artwork in
Trellis Panel. It is included by the existing `resources/licenses/**` installer
file rule; the rendered artwork itself is compiled into the renderer output.

The LICENSE files, NOTICE files and provenance.json are exact byte copies from
`src/renderer/src/assets/tool-brands/`. Their upstream sources, fixed revisions,
retrieval dates and hashes are documented below and in provenance.json. Keep
these copies synchronized when updating artwork or notices. Verify without
opening Chromium using `node scripts/smoke/tool-brands.mjs --notices-only`.

The four official website assets Pi, Factory Droid, Augment and iFlow have no
stated license. `LicenseRef-Upstream-Trademark` records that fact; it is not a
license grant. Product names and marks remain with their respective owners.

Both the source and distribution asset directories are marked `-text` in the
root Git attributes, preserving upstream bytes and SHA-256 across Windows
checkouts. Ordinary source-file line-ending rules are unchanged.

The source catalog README follows unchanged.

---

# Offline tool brand assets

This catalog contains **50** editor/coding-agent product identities, not every
product in the market. It is presentation metadata: adding an icon does not add
native metadata indexing, ACP support or conversation navigation.

SVG/PNG artwork is copied byte-for-byte from its recorded upstream source.
Monochrome SVGs are rendered as local CSS masks using `currentColor`. Colored
SVGs and PNGs retain their original artwork with `object-fit: contain` in the
same square slot. There is no dependency, remote fetch or CDN at render time.

`provenance.json` records a pinned Git commit/source path for repository assets,
and a retrieval date/hash for official website assets. All SVGs were parsed and
checked for executable markup and external content references before inclusion.
The XML namespace URLs and local gradient/clip references are not remote fetches.

`LICENSE.*.txt` and `NOTICE.*.txt` preserve actual upstream terms. Four website
assets have no stated license; see `LICENSE.upstream-trademarks.md`. No general
project license is asserted over third-party trademarks.

The local runtime IDs `claude`, `gemini`, `kimi` and `qwen` explicitly identify
Claude Code, Gemini CLI, Kimi Code and Qwen Code here. They do not identify the
vendors' general chat/model products. `copilot` maps to GitHub Copilot, and Devin
and Windsurf remain distinct. Arbitrary names are not matched by substring.

Snow, Reasonix, OhMyPi (`omp`) and Grok currently lack a verified coding
product mark in this bounded collection and use the neutral unknown fallback.
`panel`, custom engines and unbound entries are also neutral. Inflection Pi,
Microsoft Copilot, Z.ai and generic OpenAI/Claude marks are not substitutions.

| Brand | File | Mode | Source | License |
| --- | --- | --- | --- | --- |
| Codex | `codex.svg` | mask | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Claude Code | `claude-code.svg` | image | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Cursor | `cursor.svg` | mask | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Windsurf | `windsurf.svg` | mask | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| GitHub Copilot | `github-copilot.svg` | mask | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Gemini CLI | `gemini-cli.svg` | image | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| OpenCode | `opencode.svg` | mask | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Qoder | `qoder.svg` | mask | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Kiro | `kiro.svg` | image | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| CodeBuddy | `codebuddy.svg` | image | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Trae | `trae.svg` | image | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Cline | `cline.svg` | mask | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Roo Code | `roo-code.svg` | mask | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Kilo Code | `kilo-code.svg` | mask | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Amp | `amp.svg` | image | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Antigravity | `antigravity.svg` | image | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| OpenHands | `openhands.svg` | image | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Goose | `goose.svg` | mask | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Replit | `replit.svg` | image | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Devin | `devin.svg` | image | https://github.com/lobehub/lobe-icons @ `21b2144f4ebe87ead9b7c0e10067759ae261b03e` | MIT |
| Visual Studio Code | `vscode.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| VSCodium | `vscodium.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| Visual Studio | `visual-studio.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| JetBrains | `jetbrains.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| IntelliJ IDEA | `intellij-idea.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| WebStorm | `webstorm.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| PyCharm | `pycharm.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| Neovim | `neovim.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| Vim | `vim.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| Emacs | `emacs.svg` | mask | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| Android Studio | `android-studio.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| Eclipse | `eclipse.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| Xcode | `xcode.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| Rider | `rider.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| GoLand | `goland.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| PhpStorm | `phpstorm.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| CLion | `clion.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| RubyMine | `rubymine.svg` | image | https://github.com/devicons/devicon @ `6a37858047b0e8d9c9c0e68f4a071fc410652e89` | MIT |
| Zed | `zed.svg` | mask | https://github.com/simple-icons/simple-icons @ `c71c69e3a27e4436936b831c72643e6513b9f49b` | CC0-1.0 |
| Sublime Text | `sublime-text.svg` | mask | https://github.com/simple-icons/simple-icons @ `c71c69e3a27e4436936b831c72643e6513b9f49b` | CC0-1.0 |
| ZCode | `zcode.png` | image | https://github.com/zai-org/ZCode @ `3c5b227649371507ddc4eb46ac5133afe6db1cab` | Apache-2.0 |
| Aider | `aider.png` | image | https://github.com/Aider-AI/aider @ `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` | Apache-2.0 |
| Continue | `continue.svg` | mask | https://github.com/continuedev/continue @ `5522c6f44ca0ac3528b37244818fbfa39b5af470` | Apache-2.0 |
| Kimi Code | `kimi-code.png` | image | https://github.com/moonshotai/kimi-cli @ `9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82` | Apache-2.0 |
| Qwen Code | `qwen-code.svg` | image | https://github.com/QwenLM/qwen-code @ `257b9f5413ca2606092cfd5bc58cae77271b0534` | Apache-2.0 |
| Pi | `pi.svg` | image | https://pi.dev/logo-auto.svg @ `2026-10-22` | LicenseRef-Upstream-Trademark |
| Factory Droid | `factory-droid.svg` | image | https://factory.com/icon.svg @ `2026-10-22` | LicenseRef-Upstream-Trademark |
| Augment | `augment.png` | image | https://docs.augmentcode.com/mintlify-assets/_mintlify/favicons/augment-mtje7p526w/MMO3uIP-KlW_55xJ/_generated/favicon/android-chrome-192x192.png @ `2026-10-22` | LicenseRef-Upstream-Trademark |
| iFlow CLI | `iflow.png` | image | https://cli.iflow.cn/img/favicon.ico @ `2026-10-22` | LicenseRef-Upstream-Trademark |
| DeepSeek DSH | `deepseek.svg` | image | https://github.com/deepseek-ai/deepseek-harness @ `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` | MIT; brand guidelines in `NOTICE.deepseek-harness.md` |

## Product identity evidence

- ZCode: original `packages/desktop/build/icons/64x64.png` in `zai-org/ZCode`.
- Codex and Claude Code: distinct `codex.svg` and `claudecode-color.svg` in
  LobeHub's static SVG package, not `openai.svg` or `claude.svg`.
- Gemini CLI: dedicated upstream `geminicli-color.svg` product entry.
- Kimi Code: the official `KimiCliBrand` component imports `web/public/logo.png`.
- Qwen Code: the official desktop bootstrap imports `qwen-code-logo.svg`.
- Pi: the coding agent README links `https://pi.dev/logo-auto.svg`; LobeHub's
  general `pi.svg` is not used as a substitute.
- Factory Droid and Augment: official documentation favicon/logo declarations.
- iFlow CLI: official CLI page favicon declaration, original PNG response bytes.
- DeepSeek DSH: the official Harness documentation declares `website/public/favicon.svg`
  in `website/.vitepress/config.ts`. The blue whale is preserved unchanged;
  `dsh`, `deepseek` and `deepseek-harness` explicitly identify this runtime.
  `LICENSE.deepseek-harness.txt` and `NOTICE.deepseek-harness.md` preserve the
  repository's MIT license and brand guidelines; trademarks remain with DeepSeek.
