import { readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import yaml from 'js-yaml'
import type { TodoItem } from '../../shared/types'

function todosDir(projectRoot: string): string {
  return join(resolve(projectRoot), '.trellis', 'todos')
}

function parseTodoFile(filePath: string, relativePath: string): TodoItem | null {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
    let meta: Record<string, any> = {}
    let body = raw

    if (match) {
      try {
        meta = (yaml.load(match[1]) as Record<string, any>) || {}
        body = match[2].trim()
      } catch {
        // frontmatter parse fallback
      }
    }

    const id = String(meta.id || filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') || '')
    const title = String(meta.title || id)
    const priority = String(meta.priority || 'P2')
    const source = meta.source === 'jira' ? 'jira' : 'manual'
    const status = ['pending', 'converted', 'dismissed'].includes(meta.status) ? meta.status : 'pending'
    const createdAt = String(meta.createdAt || new Date().toISOString().slice(0, 10))

    return {
      id,
      title,
      description: body,
      priority,
      source,
      jiraKey: meta.jiraKey ? String(meta.jiraKey) : undefined,
      jiraUrl: meta.jiraUrl ? String(meta.jiraUrl) : undefined,
      status,
      createdAt,
      filePath: relativePath
    }
  } catch {
    return null
  }
}

export function listTodos(projectRoot: string): TodoItem[] {
  const dir = todosDir(projectRoot)
  if (!existsSync(dir)) return []
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    const items: TodoItem[] = []
    for (const f of files) {
      const full = join(dir, f)
      const parsed = parseTodoFile(full, `.trellis/todos/${f}`)
      if (parsed) items.push(parsed)
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } catch {
    return []
  }
}

export function saveTodo(
  projectRoot: string,
  input: {
    id?: string
    title: string
    description: string
    priority?: string
    source?: 'jira' | 'manual'
    jiraKey?: string
    jiraUrl?: string
    status?: 'pending' | 'converted' | 'dismissed'
  }
): TodoItem {
  const dir = todosDir(projectRoot)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const today = new Date().toISOString().slice(0, 10)
  const id = (input.id || input.jiraKey || slugify(input.title) || `todo-${Date.now()}`).trim()
  const fileName = `${id}.md`
  const fullPath = join(dir, fileName)
  const relativePath = `.trellis/todos/${fileName}`

  const meta: Record<string, any> = {
    id,
    title: input.title.trim(),
    priority: input.priority || 'P2',
    source: input.source || (input.jiraKey ? 'jira' : 'manual'),
    createdAt: today,
    status: input.status || 'pending'
  }
  if (input.jiraKey) meta.jiraKey = input.jiraKey
  if (input.jiraUrl) meta.jiraUrl = input.jiraUrl

  const frontmatter = yaml.dump(meta).trim()
  const content = `---\n${frontmatter}\n---\n\n# ${input.title.trim()}\n\n${input.description.trim()}\n`

  writeFileSync(fullPath, content, 'utf-8')

  return {
    id,
    title: meta.title,
    description: input.description.trim(),
    priority: meta.priority,
    source: meta.source,
    jiraKey: meta.jiraKey,
    jiraUrl: meta.jiraUrl,
    status: meta.status,
    createdAt: meta.createdAt,
    filePath: relativePath
  }
}

export function deleteTodo(projectRoot: string, id: string): void {
  const dir = todosDir(projectRoot)
  const fullPath = join(dir, `${id}.md`)
  if (existsSync(fullPath)) {
    unlinkSync(fullPath)
  }
}

function slugify(text: string): string {
  return text
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}
