import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { devNull } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DefaultResourceLoader, loadSkills, type ExtensionFactory, type McpServerConfig, type SettingsManager } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'
import type { PiInitialize } from '../protocol'
import { isWithin } from './storage'
import { DESIGN_GENERATION_TOOL_INSTRUCTIONS } from '../../../../shared/design-generation'

const literalValue = z.string().refine(value => !value.startsWith('!'), 'MCP command-valued credentials are disabled')
const interactiveDeliveryInstructions = `Follow the user's requested deliverable, interaction, and behavior requirements. Choose the implementation from the whole request and conversation, without requiring special keywords or a rewritten prompt.
When the user requests interactive content, implement the requested behavior in runnable HTML and JavaScript. Dragging, zooming, rotation, animation, clicking, and interactive 3D scenes must work as requested; a static image or screenshot cannot replace these behaviors. Images may be used as assets within the working implementation.
For an in-app web preview outside the design canvas, create an independent static HTML entry. Keep every CSS, JavaScript, image, font, model, and other resource inside the entry's directory (or its subdirectories) and reference them with relative URLs. Use local dependencies and bundle them when needed, including 3D libraries; the embedded preview cannot connect to external networks, CDNs, remote imports, APIs, or development servers.
For a design-canvas deliverable, use design_open; once it has delivered the pages, do not also call preview_web for that same output. For ordinary static webpage previews outside the design canvas, use the normal permission-gated write/edit and shell tools to create files, install local dependencies, or bundle. After saving that ordinary webpage entry, call preview_web with its project-relative path and a short title. preview_web only reads the saved entry and prepares its preview; it grants no write or command permission.
For attached documents, inspect the actual files and available readers before choosing a conversion strategy. Prefer a PDF text layer when available. Read a bounded page range and continue only for needed pages; do not render and read every page as images by default. Check local OCR availability before using it; a missing module is not a reason to repeat the same command or install software without authorization. If a document cannot be fully read, identify the missing pages or information and continue discussing what is known without claiming complete coverage.
For a new business idea with missing actors, workflow, constraints or source documents, clarify the highest-impact gap before generating a high-fidelity design. Carry the original requirement and answered questions across follow-up messages such as "continue". If the user explicitly requests a quick concept with assumptions, provide that concept and distinguish its assumptions from confirmed requirements. Do not claim to have created or opened a requirement workbench unless the application actually did so.
Describe completion and validation truthfully. Writing code, bundling assets, inspecting source, or preparing a preview does not establish successful browser rendering or working interactions. Claim browser or interaction verification only after actually exercising the page with a browser tool, and state which behavior was checked. If browser verification was unavailable or not performed, say so.`
const mcpSchema = z.object({
  type: z.enum(['stdio', 'http', 'streamable-http']).optional(), command: z.string().min(1).regex(/^[^\r\n]+$/).optional(),
  args: z.array(z.string()).max(64).optional(), cwd: z.string().optional(),
  env: z.record(z.string(), literalValue).optional(), url: z.string().url().optional(),
  headers: z.record(z.string(), literalValue).optional(), timeout: z.number().positive().optional(),
  enabled: z.boolean().optional(), description: z.string().optional(), exposure: z.literal('direct').optional()
}).strict().refine(value => Boolean(value.command) !== Boolean(value.url), 'MCP requires exactly one command or URL')

export function mcpRegistration(input: PiInitialize): ExtensionFactory {
  const names = new Set<string>()
  const servers = input.mcpServers.map(server => {
    const name = server.name.replaceAll('-', '_')
    if (names.has(name)) throw new Error('Duplicate MCP namespace')
    names.add(name)
    const config = mcpSchema.parse(server.config)
    if (config.enabled === false) throw new Error('Selected MCP server is disabled')
    let native: McpServerConfig
    if (config.url) {
      if (config.type === 'stdio' || config.command) throw new Error('Invalid MCP HTTP transport')
      native = { type: 'http', url: config.url, headers: config.headers, description: config.description, timeout: config.timeout, exposure: 'direct' }
    } else {
      if (!config.command || (config.type !== undefined && config.type !== 'stdio')) throw new Error('Invalid MCP stdio transport')
      native = { type: 'stdio', command: config.command, args: config.args, cwd: config.cwd, env: config.env,
        description: config.description, timeout: config.timeout, exposure: 'direct' }
    }
    return { name: server.name, config: native }
  })
  return pi => {
    for (const server of servers) pi.registerMcpServer(server.name, server.config)
  }
}

function readProjectFile(root: string, file: string, maxBytes: number): { path: string; content: string } {
  const canonical = realpathSync(file)
  const info = statSync(canonical)
  if (!isWithin(root, canonical) || !info.isFile() || info.size > maxBytes) {
    throw new Error('Pi project instruction/skill file is outside the project or exceeds its size limit')
  }
  return { path: canonical, content: new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(canonical)).replace(/^\uFEFF/, '') }
}

function projectContext(input: PiInitialize): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = []
  let dir = input.cwd
  let totalBytes = 0
  for (;;) {
    for (const name of ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']) {
      const file = join(dir, name)
      if (!existsSync(file)) continue
      const loaded = readProjectFile(input.root, file, 128 * 1024)
      totalBytes += Buffer.byteLength(loaded.content)
      if (totalBytes > 1024 * 1024) throw new Error('Pi project context exceeds 1 MiB')
      files.unshift(loaded)
      break
    }
    if (dir === input.root) break
    dir = dirname(dir)
  }
  return files
}

export function createResources(input: PiInitialize, settingsManager: SettingsManager, factories: ExtensionFactory[]): DefaultResourceLoader {
  const selected = input.skillPaths.map(path => {
    const file = resolve(input.root, path)
    if (!isWithin(input.root, file) || basename(file) !== 'SKILL.md') throw new Error('Selected skills must be project SKILL.md files')
    return readProjectFile(input.root, file, 128 * 1024).path
  })
  if (new Set(selected).size !== selected.length) throw new Error('Duplicate selected skill path')
  const skills = loadSkills({ cwd: input.cwd, agentDir: input.agentDir, skillPaths: selected, includeDefaults: false })
  if (skills.diagnostics.length || skills.skills.length !== selected.length) throw new Error('Invalid selected Pi skill manifest')
  const agentsFiles = projectContext(input)
  return new DefaultResourceLoader({
    cwd: input.cwd, agentDir: input.agentDir, settingsManager,
    noExtensions: true, disabledBuiltinExtensions: ['mcp', 'codemode', 'tool-search'],
    extensionFactories: factories, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    // Empty sources prevent even reading arbitrary SYSTEM.md/APPEND_SYSTEM.md files.
    systemPrompt: '', appendSystemPrompt: [], systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [interactiveDeliveryInstructions, DESIGN_GENERATION_TOOL_INSTRUCTIONS,
      `Project root for preview_web paths and design_open output: ${input.root}`, ...(input.instructions ? [input.instructions] : [])],
    skillsOverride: () => skills, agentsFilesOverride: () => ({ agentsFiles }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }), themesOverride: () => ({ themes: [], diagnostics: [] })
  })
}

export const mcpLogPath = devNull
