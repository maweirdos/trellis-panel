/** Offline editor/coding-agent identities. This is presentation metadata, not a runtime capability registry. */
export interface ToolBrandDefinition {
  readonly id: string
  readonly label: string
  readonly aliases: readonly string[]
  readonly assetKey: string
  readonly mode: 'mask' | 'image'
}

/** Assets and their exact upstream revisions/licenses are recorded in renderer assets/tool-brands/provenance.json. */
export const TOOL_BRANDS = [
  { id: 'codex', label: 'Codex', aliases: ['codex-cli', 'openai-codex'], assetKey: 'codex.svg', mode: 'mask' },
  { id: 'claude-code', label: 'Claude Code', aliases: ['claude', 'claudecode', 'claude_code', 'claude-code-cli'], assetKey: 'claude-code.svg', mode: 'image' },
  { id: 'cursor', label: 'Cursor', aliases: ['cursor-agent'], assetKey: 'cursor.svg', mode: 'mask' },
  { id: 'windsurf', label: 'Windsurf', aliases: ['windsurf-editor'], assetKey: 'windsurf.svg', mode: 'mask' },
  { id: 'github-copilot', label: 'GitHub Copilot', aliases: ['copilot', 'githubcopilot', 'github_copilot', 'copilot-cli'], assetKey: 'github-copilot.svg', mode: 'mask' },
  { id: 'gemini-cli', label: 'Gemini', aliases: ['gemini', 'geminicli', 'gemini_cli'], assetKey: 'gemini-cli.svg', mode: 'image' },
  { id: 'opencode', label: 'OpenCode', aliases: ['open-code', 'open_code'], assetKey: 'opencode.svg', mode: 'mask' },
  { id: 'qoder', label: 'Qoder', aliases: ['qoder-cli'], assetKey: 'qoder.svg', mode: 'mask' },
  { id: 'kiro', label: 'Kiro', aliases: ['kiro-cli'], assetKey: 'kiro.svg', mode: 'image' },
  { id: 'codebuddy', label: 'CodeBuddy', aliases: ['code-buddy', 'codebuddy-cli'], assetKey: 'codebuddy.svg', mode: 'image' },
  { id: 'trae', label: 'Trae', aliases: ['trae-cn', 'trae-solo'], assetKey: 'trae.svg', mode: 'image' },
  { id: 'cline', label: 'Cline', aliases: [], assetKey: 'cline.svg', mode: 'mask' },
  { id: 'roo-code', label: 'Roo Code', aliases: ['roo', 'roocode', 'roo_code'], assetKey: 'roo-code.svg', mode: 'mask' },
  { id: 'kilo-code', label: 'Kilo Code', aliases: ['kilo', 'kilocode', 'kilo_code'], assetKey: 'kilo-code.svg', mode: 'mask' },
  { id: 'amp', label: 'Amp', aliases: ['ampcode', 'amp-code'], assetKey: 'amp.svg', mode: 'image' },
  { id: 'antigravity', label: 'Antigravity', aliases: ['google-antigravity'], assetKey: 'antigravity.svg', mode: 'image' },
  { id: 'openhands', label: 'OpenHands', aliases: ['open-hands'], assetKey: 'openhands.svg', mode: 'image' },
  { id: 'goose', label: 'Goose', aliases: ['block-goose'], assetKey: 'goose.svg', mode: 'mask' },
  { id: 'replit', label: 'Replit', aliases: ['replit-agent'], assetKey: 'replit.svg', mode: 'image' },
  { id: 'devin', label: 'Devin', aliases: [], assetKey: 'devin.svg', mode: 'image' },
  { id: 'vscode', label: 'Visual Studio Code', aliases: ['vs-code', 'visual-studio-code', 'code'], assetKey: 'vscode.svg', mode: 'image' },
  { id: 'vscodium', label: 'VSCodium', aliases: ['codium'], assetKey: 'vscodium.svg', mode: 'image' },
  { id: 'visual-studio', label: 'Visual Studio', aliases: ['visualstudio'], assetKey: 'visual-studio.svg', mode: 'image' },
  { id: 'jetbrains', label: 'JetBrains', aliases: [], assetKey: 'jetbrains.svg', mode: 'image' },
  { id: 'intellij-idea', label: 'IntelliJ IDEA', aliases: ['intellij', 'idea'], assetKey: 'intellij-idea.svg', mode: 'image' },
  { id: 'webstorm', label: 'WebStorm', aliases: [], assetKey: 'webstorm.svg', mode: 'image' },
  { id: 'pycharm', label: 'PyCharm', aliases: [], assetKey: 'pycharm.svg', mode: 'image' },
  { id: 'neovim', label: 'Neovim', aliases: ['nvim'], assetKey: 'neovim.svg', mode: 'image' },
  { id: 'vim', label: 'Vim', aliases: [], assetKey: 'vim.svg', mode: 'image' },
  { id: 'emacs', label: 'Emacs', aliases: ['gnu-emacs'], assetKey: 'emacs.svg', mode: 'mask' },
  { id: 'android-studio', label: 'Android Studio', aliases: ['androidstudio'], assetKey: 'android-studio.svg', mode: 'image' },
  { id: 'eclipse', label: 'Eclipse', aliases: [], assetKey: 'eclipse.svg', mode: 'image' },
  { id: 'xcode', label: 'Xcode', aliases: [], assetKey: 'xcode.svg', mode: 'image' },
  { id: 'rider', label: 'Rider', aliases: ['jetbrains-rider'], assetKey: 'rider.svg', mode: 'image' },
  { id: 'goland', label: 'GoLand', aliases: [], assetKey: 'goland.svg', mode: 'image' },
  { id: 'phpstorm', label: 'PhpStorm', aliases: [], assetKey: 'phpstorm.svg', mode: 'image' },
  { id: 'clion', label: 'CLion', aliases: [], assetKey: 'clion.svg', mode: 'image' },
  { id: 'rubymine', label: 'RubyMine', aliases: [], assetKey: 'rubymine.svg', mode: 'image' },
  { id: 'zed', label: 'Zed', aliases: ['zed-editor', 'zedindustries'], assetKey: 'zed.svg', mode: 'mask' },
  { id: 'sublime-text', label: 'Sublime Text', aliases: ['sublime', 'sublimetext', 'subl'], assetKey: 'sublime-text.svg', mode: 'mask' },
  { id: 'zcode', label: 'ZCode', aliases: ['z-code'], assetKey: 'zcode.png', mode: 'image' },
  { id: 'aider', label: 'Aider', aliases: [], assetKey: 'aider.png', mode: 'image' },
  { id: 'continue', label: 'Continue', aliases: ['continue-dev', 'continuedev', 'cn'], assetKey: 'continue.svg', mode: 'mask' },
  { id: 'kimi-code', label: 'Kimi Code', aliases: ['kimi', 'kimi-cli', 'kimi_code'], assetKey: 'kimi-code.png', mode: 'image' },
  { id: 'qwen-code', label: 'Qwen Code', aliases: ['qwen', 'qwen-cli', 'qwen_code'], assetKey: 'qwen-code.svg', mode: 'image' },
  { id: 'pi', label: 'Pi', aliases: ['pi-agent', 'pi-coding-agent'], assetKey: 'pi.svg', mode: 'image' },
  { id: 'factory-droid', label: 'Factory Droid', aliases: ['factory', 'droid'], assetKey: 'factory-droid.svg', mode: 'image' },
  { id: 'augment', label: 'Augment', aliases: ['augment-code', 'augmentcode', 'auggie'], assetKey: 'augment.png', mode: 'image' },
  { id: 'iflow', label: 'iFlow CLI', aliases: ['iflow-cli', 'i-flow'], assetKey: 'iflow.png', mode: 'image' },
  { id: 'deepseek-dsh', label: 'DeepSeek DSH', aliases: ['dsh', 'deepseek', 'deepseek-harness'], assetKey: 'deepseek.svg', mode: 'image' },
] as const satisfies readonly ToolBrandDefinition[]

export type ToolBrandId = typeof TOOL_BRANDS[number]['id']
export type ToolBrand = typeof TOOL_BRANDS[number]

// `claude`, `gemini`, `kimi` and `qwen` are explicit project runtime IDs for their coding products.
// Do not infer a brand from an arbitrary title, provider name, substring or executable path.
const TOOL_BRAND_ALIASES = new Map<string, ToolBrand>(
  TOOL_BRANDS.flatMap((brand) => [brand.id, ...brand.aliases].map((alias) => [alias, brand] as const)),
)

export function getToolBrand(brand: string | undefined): ToolBrand | undefined {
  return brand ? TOOL_BRAND_ALIASES.get(brand.trim().toLowerCase()) : undefined
}
