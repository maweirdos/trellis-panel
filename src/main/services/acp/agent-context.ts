import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { acpSkillContextSchema, acpSkillPathsSchema, type AcpSkillContext } from '../../../shared/acp-context'
import type { AcpAgentProfile } from '../../../shared/types'
import { resolveAuthorizedDocumentPath } from '../documents/paths'

const MAX_SKILL_BYTES = 128 * 1024
const MAX_FRONTMATTER_CHARS = 16 * 1024
const MAX_CONTEXT_BYTES = 128 * 1024
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

interface SkillSource { skill: AcpSkillContext; canonicalPath: string }

/** Read exactly one bounded, project-fenced skill; never execute its contents. */
function readSkill(root: string, relativePath: string): SkillSource {
  const target = resolveAuthorizedDocumentPath(root, relativePath)
  if (!target.ok || !target.exists) throw new Error(`绑定技能不存在或超出当前项目：${relativePath}`)
  const descriptor = openSync(target.canonicalPath, 'r')
  let bytes: Buffer
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.size > MAX_SKILL_BYTES) throw new Error(`技能文件必须是不超过 128 KiB 的文本：${relativePath}`)
    const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const received = readSync(descriptor, buffer, length, buffer.length - length, null)
      if (received === 0) break
      length += received
    }
    const after = fstatSync(descriptor)
    const current = resolveAuthorizedDocumentPath(root, relativePath)
    if (length > MAX_SKILL_BYTES || length !== after.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || !current.ok || !current.exists || current.canonicalPath !== target.canonicalPath) throw new Error(`技能文件在读取时发生变化：${relativePath}`)
    bytes = buffer.subarray(0, length)
  } finally { closeSync(descriptor) }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new Error(`技能文件不是有效的 UTF-8 文本：${relativePath}`) }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)
  if (!frontmatter || frontmatter[1].length > MAX_FRONTMATTER_CHARS) throw new Error(`技能缺少有效的名称和适用说明：${relativePath}`)
  let metadata: unknown
  try { metadata = yaml.load(frontmatter[1], { schema: yaml.JSON_SCHEMA }) }
  catch { throw new Error(`技能的 YAML 描述无效：${relativePath}`) }
  const parsed = acpSkillContextSchema.safeParse({ ...(typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? metadata : {}),
    relativePath, revision: hash(bytes) })
  if (!parsed.success) throw new Error(`技能需要有效的 name（不超过 200 字符）和 description（不超过 2000 字符）：${relativePath}`)
  return { skill: parsed.data, canonicalPath: target.canonicalPath }
}

export interface PreparedAgentContext {
  resource: { uri: string; mimeType: 'text/markdown'; text: string }
  revision: string
  instructionsProvided: boolean
  skills: AcpSkillContext[]
  assertCurrent(): void
}

/** The user-selected role is a separate ACP resource, never a fabricated system prompt. */
export function prepareAgentContext(root: string, sessionId: string, profile?: AcpAgentProfile): PreparedAgentContext | undefined {
  const paths = acpSkillPathsSchema.parse(profile?.skillPaths ?? [])
  const instructions = profile?.instructions ?? ''
  if (!instructions.trim() && paths.length === 0) return undefined
  const sources = paths.map((path) => readSkill(root, path))
  if (new Set(sources.map((source) => source.canonicalPath)).size !== sources.length) throw new Error('同一技能文件不能通过多个路径重复绑定')
  const skills = sources.map((source) => source.skill)
  const text = [
    'User-selected role configuration for this conversation. The current user message defines the requested work and takes precedence.',
    ...(instructions.trim() ? ['## Role instructions', instructions] : []),
    ...(skills.length ? ['## Available project skills',
      'Choose skills by their descriptions. Read the matching SKILL.md before following its workflow; load supporting resources only when needed. The catalog is not the full skill content.',
      JSON.stringify(skills.map((skill, index) => ({ name: skill.name, description: skill.description, path: skill.relativePath,
        uri: pathToFileURL(sources[index].canonicalPath).href })), null, 2)] : [])
  ].join('\n\n')
  if (Buffer.byteLength(text, 'utf8') > MAX_CONTEXT_BYTES) throw new Error('角色指令与技能清单超过 128 KiB，请缩减后重试')
  const revision = hash(JSON.stringify({ text, skills }))
  return { resource: { uri: `trellis://agent-context/${encodeURIComponent(sessionId)}/${revision}`, mimeType: 'text/markdown', text }, revision,
    instructionsProvided: Boolean(instructions.trim()), skills,
    assertCurrent: () => {
      for (const source of sources) {
        const current = readSkill(root, source.skill.relativePath)
        if (current.canonicalPath !== source.canonicalPath || current.skill.revision !== source.skill.revision) throw new Error(`技能已改变，请重新发送以读取最新版本：${source.skill.relativePath}`)
      }
    } }
}
