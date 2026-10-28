import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync, mkdirSync, realpathSync, opendirSync, openSync, readSync, closeSync } from 'fs'
import { join, basename, extname, relative, sep, resolve, dirname, isAbsolute } from 'path'
import type { KbDoc, KbHit, KbLibrary, KbQaEntry, KbSearchResult, KbBrowseInput, KbBrowseSuccess, KbSearchScope } from '../../shared/types'

/**
 * 知识库（五库合一）：
 *   requirements —— 原始需求（活动任务的 prd.md / task.json 提炼）
 *   spec        —— 规范知识库（.trellis/spec/**）
 *   wiki        —— 项目 Wiki（README / docs / wiki 等仓库文档）
 *   archive     —— 归档知识库（.trellis/archive 与 tasks/archive）
 *   notes       —— 我的笔记（.trellis/notes/*.md，面板内可读写）
 *
 * 检索方案参考本地优先开源案例（Obsidian/Logseq 的倒排索引 + IDF 打分）：
 * CJK 二元分词 + 拉丁词元，AND 语义，TF-IDF 排序，窗口摘要高亮。
 * 索引按 (mtime,size) 增量缓存，进程内复用。
 */

const MAX_FILE_BYTES = 512 * 1024
const MAX_DOCS = 4000
const MAX_BROWSE_ENTRIES = 4000
const MAX_BROWSE_DOCS = 1000
const MAX_BROWSE_BYTES = 16 * 1024 * 1024
const TEXT_EXTS = new Set(['.md', '.markdown', '.txt'])

interface IndexedDoc {
  doc: KbDoc
  /** 检索词元 → 词频 */
  tokens: Map<string, number>
  /** 摘要用原文（截断） */
  text: string
}

interface CacheEntry {
  mtime: number
  size: number
  indexed: IndexedDoc | null // null = 读取/解析失败
}

const cache = new Map<string, CacheEntry>()

/* ---------------- 分词 ---------------- */

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'not', 'you', 'your', 'can', 'has', 'have', 'will', 'would', 'should', 'could', 'than', 'then', 'them', 'they', 'were', 'been', 'being', 'its', 'it\'s', 'our', 'out', 'about', 'over', 'all', 'also'])

export function tokenize(text: string, out: Map<string, number>): void {
  const lower = text.toLowerCase()
  for (const w of lower.matchAll(/[a-z][a-z0-9_\-]{1,}/g)) {
    const t = w[0].replace(/^-+|-+$/g, '')
    if (t.length >= 2 && !STOP.has(t)) out.set(t, (out.get(t) ?? 0) + 1)
  }
  for (const run of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const s = run[0]
    if (s.length === 1) {
      out.set(s, (out.get(s) ?? 0) + 1)
      continue
    }
    for (let i = 0; i < s.length - 1; i += 1) {
      const bg = s.slice(i, i + 2)
      out.set(bg, (out.get(bg) ?? 0) + 1)
    }
  }
}

export function tokenizeQuery(query: string): string[] {
  const m = new Map<string, number>()
  tokenize(query, m)
  return [...m.keys()]
}

/* ---------------- 语料发现 ---------------- */

type BrowseLimitReason = 'entry_limit' | 'document_limit' | 'byte_limit' | 'unreadable'
interface BrowseBudget { entries: number; reads: number; bytes: number; reason?: BrowseLimitReason; folderPath?: string; folderRecursive?: boolean }
function directoryNames(dir: string, budget?: BrowseBudget): string[] {
  if (!budget) return readdirSync(dir)
  const names: string[] = []
  const handle = opendirSync(dir)
  try {
    for (;;) {
      const entry = handle.readSync()
      if (!entry) break
      if (budget.entries >= MAX_BROWSE_ENTRIES) { budget.reason ??= 'entry_limit'; break }
      budget.entries++
      names.push(entry.name)
    }
  } finally { handle.closeSync() }
  return names
}

function insideProject(root: string, path: string): boolean {
  try {
    const rel = relative(root, realpathSync(path))
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  } catch { return false }
}

function isDir(p: string, fencedRoot?: string): boolean {
  try {
    return (!fencedRoot || insideProject(fencedRoot, p)) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

function readText(p: string, maxBytes = MAX_FILE_BYTES, fencedRoot?: string, budget?: BrowseBudget): string | null {
  try {
    if (fencedRoot && budget?.folderPath !== undefined) {
      const dir = relative(fencedRoot, dirname(p)).split(sep).join('/')
      if (dir !== budget.folderPath && !(budget.folderRecursive && (budget.folderPath === '' || dir.startsWith(`${budget.folderPath}/`)))) return null
    }
    if (fencedRoot && !insideProject(fencedRoot, p)) return null
    const st = statSync(p)
    if (st.size > maxBytes) { if (budget) budget.reason ??= 'unreadable'; return null }
    if (budget) {
      if (budget.reads >= MAX_BROWSE_DOCS) { budget.reason ??= 'document_limit'; return null }
      if (budget.bytes + st.size > MAX_BROWSE_BYTES) { budget.reason ??= 'byte_limit'; return null }
      budget.reads++; budget.bytes += st.size
    }
    let c: string
    if (budget) {
      // The file can grow after stat; never let one read exceed the reserved budget.
      const fd = openSync(p, 'r')
      try {
        const bytes = Buffer.allocUnsafe(st.size + 1)
        let used = 0
        while (used < bytes.length) {
          const count = readSync(fd, bytes, used, bytes.length - used, null)
          if (!count) break
          used += count
        }
        if (used > st.size) { budget.reason ??= 'unreadable'; return null }
        c = bytes.toString('utf8', 0, used)
      } finally { closeSync(fd) }
    } else c = readFileSync(p, 'utf-8')
    if (c.charCodeAt(0) === 0xfeff) c = c.slice(1)
    return c
  } catch {
    if (budget && existsSync(p) && (!fencedRoot || insideProject(fencedRoot, p))) budget.reason ??= 'unreadable'
    return null
  }
}

function walkFiles(dir: string, maxDepth: number, skip: Set<string>, acc: string[], depth = 0, fencedRoot?: string, budget?: BrowseBudget): void {
  if (depth > maxDepth || (!fencedRoot && acc.length > MAX_DOCS) || (fencedRoot && !insideProject(fencedRoot, dir))) return
  let names: string[] = []
  try {
    names = directoryNames(dir, budget)
  } catch {
    if (budget) budget.reason ??= 'unreadable'
    return
  }
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue
    const p = join(dir, name)
    if (isDir(p, fencedRoot)) {
      if (skip.has(name)) continue
      walkFiles(p, maxDepth, skip, acc, depth + 1, fencedRoot, budget)
    } else if (TEXT_EXTS.has(extname(name).toLowerCase()) && (!fencedRoot || insideProject(fencedRoot, p))) {
      acc.push(p)
    }
  }
}

interface RawDoc {
  path: string
  title: string
  group: string
  text: string
  synthetic?: boolean
}

function collectSpec(root: string, out: RawDoc[], fencedRoot?: string, budget?: BrowseBudget): void {
  const files: string[] = []
  walkFiles(join(root, '.trellis', 'spec'), 6, new Set(), files, 0, fencedRoot, budget)
  for (const p of files) {
    const text = readText(p, MAX_FILE_BYTES, fencedRoot, budget)
    if (text === null) continue
    const rel = relative(join(root, '.trellis', 'spec'), p).split(sep).join('/')
    out.push({
      path: p,
      title: firstHeading(text) ?? basename(p),
      group: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '(根)',
      text
    })
  }
}

function taskJsonDigest(dir: string, fencedRoot?: string, budget?: BrowseBudget): { title: string; body: string } | null {
  const raw = readText(join(dir, 'task.json'), 256 * 1024, fencedRoot, budget)
  if (!raw) return null
  try {
    const o = JSON.parse(raw)
    if (!o || typeof o !== 'object') return null
    const subtasks = Array.isArray(o.subtasks) ? (o.subtasks as unknown[]).map(String).join('\n') : ''
    const body = [String(o.description ?? ''), String(o.notes ?? ''), subtasks].filter(Boolean).join('\n\n')
    return { title: String(o.title ?? basename(dir)), body }
  } catch {
    return null
  }
}

const REQUIREMENT_FILES = ['prd.md', 'PRD.md', 'requirement.md', 'requirements.md', 'design.md', 'README.md']

function collectRequirements(root: string, out: RawDoc[], fencedRoot?: string, budget?: BrowseBudget): void {
  const tasksRoot = join(root, '.trellis', 'tasks')
  if (!isDir(tasksRoot, fencedRoot)) return
  let names: string[] = []
  try {
    names = directoryNames(tasksRoot, budget)
  } catch {
    if (budget) budget.reason ??= 'unreadable'
    return
  }
  for (const name of names.sort()) {
    const dir = join(tasksRoot, name)
    if (!isDir(dir, fencedRoot) || name.startsWith('.') || name === 'archive') continue
    for (const f of REQUIREMENT_FILES) {
      const p = join(dir, f)
      if (!existsSync(p)) continue
      const text = readText(p, MAX_FILE_BYTES, fencedRoot, budget)
      if (text === null) continue
      out.push({ path: p, title: firstHeading(text) ?? `${name}/${f}`, group: name, text })
      break // 每个任务只取首选需求文档
    }
    const digest = taskJsonDigest(dir, fencedRoot, budget)
    if (digest && digest.body.trim()) {
      out.push({
        path: join(dir, 'task.json'),
        title: digest.title,
        group: name,
        text: `${digest.title}\n${digest.body}`,
        synthetic: true
      })
    }
  }
}

function collectArchive(root: string, out: RawDoc[], fencedRoot?: string, budget?: BrowseBudget): void {
  const roots = [join(root, '.trellis', 'archive'), join(root, '.trellis', 'tasks', 'archive')]
  const seenDirs = new Set<string>()
  for (const archiveRoot of roots) {
    if (!isDir(archiveRoot, fencedRoot)) continue
    const stack: Array<{ dir: string; depth: number }> = [{ dir: archiveRoot, depth: 0 }]
    while (stack.length > 0) {
      const { dir, depth } = stack.pop()!
      let names: string[] = []
      try {
        names = directoryNames(dir, budget)
      } catch {
        if (budget) budget.reason ??= 'unreadable'
        continue
      }
      if (names.includes('task.json') && !seenDirs.has(dir)) {
        seenDirs.add(dir)
        const name = basename(dir)
        for (const f of REQUIREMENT_FILES) {
          const p = join(dir, f)
          if (!existsSync(p)) continue
          const text = readText(p, MAX_FILE_BYTES, fencedRoot, budget)
          if (text === null) continue
          out.push({ path: p, title: firstHeading(text) ?? `${name}/${f}`, group: name, text })
          break
        }
        const digest = taskJsonDigest(dir, fencedRoot, budget)
        if (digest && digest.body.trim()) {
          out.push({
            path: join(dir, 'task.json'),
            title: digest.title,
            group: name,
            text: `${digest.title}\n${digest.body}`,
            synthetic: true
          })
        }
        continue
      }
      if (depth >= 4) continue
      for (const name of names.sort()) {
        if (name.startsWith('.')) continue
        const child = join(dir, name)
        if (isDir(child, fencedRoot)) stack.push({ dir: child, depth: depth + 1 })
      }
    }
  }
}

const WIKI_SKIP = new Set(['node_modules', '.git', 'out', 'dist', 'release', 'coverage', 'build', '.next', 'target', 'vendor'])
const WIKI_ROOT_FILES = ['README.md', 'readme.md', 'AGENTS.md', 'CLAUDE.md', 'ARCHITECTURE.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'DESIGN.md']

function collectWiki(root: string, out: RawDoc[], fencedRoot?: string, budget?: BrowseBudget): void {
  for (const f of WIKI_ROOT_FILES) {
    const p = join(root, f)
    if (!existsSync(p)) continue
    const text = readText(p, MAX_FILE_BYTES, fencedRoot, budget)
    if (text === null) continue
    out.push({ path: p, title: firstHeading(text) ?? f, group: '(仓库根)', text })
  }
  for (const sub of ['docs', 'doc', 'wiki', 'docs-cn', 'documentation']) {
    const files: string[] = []
    walkFiles(join(root, sub), 5, WIKI_SKIP, files, 0, fencedRoot, budget)
    for (const p of files) {
      const text = readText(p, MAX_FILE_BYTES, fencedRoot, budget)
      if (text === null) continue
      const rel = relative(join(root, sub), p).split(sep).join('/')
      out.push({
        path: p,
        title: firstHeading(text) ?? basename(p),
        group: rel.includes('/') ? `${sub}/${rel.slice(0, rel.lastIndexOf('/'))}` : sub,
        text
      })
    }
  }
}

/** 我的笔记（.trellis/notes/*.md，面板可读写） */
function collectNotes(root: string, out: RawDoc[], fencedRoot?: string, budget?: BrowseBudget): void {
  const notesRoot = join(root, '.trellis', 'notes')
  const files: string[] = []
  walkFiles(notesRoot, 3, new Set(), files, 0, fencedRoot, budget)
  for (const p of files) {
    const text = readText(p, MAX_FILE_BYTES, fencedRoot, budget)
    if (text === null) continue
    const rel = relative(notesRoot, p).split(sep).join('/')
    out.push({
      path: p,
      title: firstHeading(text) ?? basename(p, extname(p)),
      group: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '(笔记)',
      text
    })
  }
}

/* ---------------- 我的笔记读写 ---------------- */

/** 笔记文件名合法性：仅一层 .md，防路径穿越 */
function safeNoteName(fileName: string): string | null {
  const name = String(fileName ?? '').trim()
  if (!name) return null
  const withExt = name.toLowerCase().endsWith('.md') ? name : `${name}.md`
  if (!/^[A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_\-\u4e00-\u9fff .()]*\.md$/.test(withExt)) return null
  if (withExt.includes('/') || withExt.includes('\\') || withExt.includes('..')) return null
  return withExt
}

export function noteUpsert(root: string, fileName: string, content: string): { ok: boolean; error?: string; path?: string } {
  const name = safeNoteName(fileName)
  if (!name) return { ok: false, error: '笔记名仅允许中英文、数字、空格、- _ ( )，且不能包含路径分隔符' }
  const body = String(content ?? '')
  if (body.length > 512 * 1024) return { ok: false, error: '笔记内容超过 512KB' }
  try {
    const dir = join(root, '.trellis', 'notes')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const p = join(dir, name)
    // 围栏：最终路径必须仍在 notes 目录内
    if (relative(resolve(dir), resolve(p)).startsWith('..')) return { ok: false, error: '非法路径' }
    writeFileSync(p, body, 'utf-8')
    return { ok: true, path: p }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function noteDelete(root: string, fileName: string): { ok: boolean; error?: string } {
  const name = safeNoteName(fileName)
  if (!name) return { ok: false, error: '非法笔记名' }
  try {
    const p = join(root, '.trellis', 'notes', name)
    if (relative(resolve(join(root, '.trellis', 'notes')), resolve(p)).startsWith('..')) return { ok: false, error: '非法路径' }
    if (existsSync(p)) rmSync(p)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

function firstHeading(text: string): string | null {
  for (const line of text.split(/\r?\n/).slice(0, 30)) {
    const m = /^#\s+(.{2,80})\s*$/.exec(line.trim())
    if (m) return m[1]
  }
  return null
}

/* ---------------- 索引 ---------------- */

function indexDoc(raw: RawDoc, library: KbLibrary): IndexedDoc | null {
  let st
  try {
    st = statSync(raw.path)
  } catch {
    return null
  }
  const doc: KbDoc = {
    id: `${library}:${raw.path}`,
    library,
    path: raw.path,
    name: basename(raw.path),
    group: raw.group,
    title: raw.title || basename(raw.path),
    size: st.size,
    mtime: st.mtimeMs,
    synthetic: raw.synthetic
  }
  const tokens = new Map<string, number>()
  // 标题加权：索引两次
  tokenize(doc.title, tokens)
  for (const [k, v] of Array.from(tokens)) tokens.set(k, v)
  tokenize(raw.text, tokens)
  return { doc, tokens, text: raw.text.length > 20_000 ? raw.text.slice(0, 20_000) : raw.text }
}

function collectLibrary(root: string, library: KbLibrary, fencedRoot?: string, budget?: BrowseBudget): RawDoc[] {
  const out: RawDoc[] = []
  if (library === 'spec') collectSpec(root, out, fencedRoot, budget)
  else if (library === 'requirements') collectRequirements(root, out, fencedRoot, budget)
  else if (library === 'wiki') collectWiki(root, out, fencedRoot, budget)
  else if (library === 'archive') collectArchive(root, out, fencedRoot, budget)
  else if (library === 'notes') collectNotes(root, out, fencedRoot, budget)
  return out
}

function getIndexed(root: string, library: KbLibrary, fencedRoot?: string, budget?: BrowseBudget): IndexedDoc[] {
  const raws = collectLibrary(root, library, fencedRoot, budget)
  const result: IndexedDoc[] = []
  const fresh = new Set<string>()
  for (const raw of raws) {
    let st
    try {
      if (fencedRoot && !insideProject(fencedRoot, raw.path)) continue
      st = statSync(raw.path)
    } catch {
      continue
    }
    fresh.add(raw.path)
    const cached = cache.get(raw.path)
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size && (!fencedRoot || !cached.indexed || cached.indexed.doc.library === library)) {
      if (cached.indexed) result.push(cached.indexed)
      continue
    }
    const indexed = indexDoc(raw, library)
    cache.set(raw.path, { mtime: st.mtimeMs, size: st.size, indexed })
    if (indexed) result.push(indexed)
  }
  // 清掉已消失文件的缓存（existsSync 兜底：'all' 模式下逐库调用时不能误删其他库的缓存）
  for (const key of cache.keys()) {
    if (!fresh.has(key) && !existsSync(key)) cache.delete(key)
  }
  return result
}

/* ---------------- 检索 ---------------- */

interface ParsedQuery {
  /** 拉丁词元：必须全部命中 */
  latin: string[]
  /** CJK 词组的 bigram 集合：按 60% 覆盖率匹配（跨词 bigram 容错） */
  runs: string[][]
}

export function parseQuery(query: string): ParsedQuery {
  const latin: string[] = []
  const runs: string[][] = []
  const lower = query.toLowerCase()
  for (const w of lower.matchAll(/[a-z][a-z0-9_\-]{1,}/g)) {
    const t = w[0].replace(/^-+|-+$/g, '')
    if (t.length >= 2 && !STOP.has(t)) latin.push(t)
  }
  for (const run of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const s = run[0]
    if (s.length === 1) {
      runs.push([s])
      continue
    }
    const bigrams: string[] = []
    for (let i = 0; i < s.length - 1; i += 1) bigrams.push(s.slice(i, i + 2))
    runs.push(bigrams)
  }
  return { latin, runs }
}

function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase()
  let bestStart = 0
  let bestScore = -1
  const scanStep = 400
  for (let start = 0; start < Math.min(text.length, 8000); start += scanStep) {
    const window = lower.slice(start, start + 240)
    let score = 0
    for (const t of terms) {
      if (window.includes(t)) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      bestStart = start
    }
    if (bestScore >= terms.length) break
  }
  const raw = text.slice(bestStart, bestStart + 240).replace(/\s+/g, ' ').trim()
  let marked = raw
  for (const t of terms) {
    if (!t) continue
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    marked = marked.replace(re, '\u0000$1\u0001')
  }
  return marked
}

export function kbSearch(
  root: string,
  library: KbLibrary | 'all',
  query: string,
  scope?: KbSearchScope
): KbSearchResult {
  const t0 = Date.now()
  const fencedRoot = scope ? realpathSync(resolve(root)) : undefined
  const budget: BrowseBudget | undefined = scope ? { entries: 0, reads: 0, bytes: 0, folderPath: scope.folderPath, folderRecursive: scope.folderRecursive } : undefined
  const libs: KbLibrary[] = library === 'all' ? ['requirements', 'spec', 'wiki', 'archive', 'notes'] : [library]
  const q = query.trim().toLowerCase()
  const { latin, runs } = parseQuery(query)
  const highlightTerms = [...latin, ...runs.flat()]

  const docs: KbDoc[] = []
  const hits: KbHit[] = []
  let total = 0

  for (const lib of libs) {
    const candidates = scope && fencedRoot ? collectLibrary(fencedRoot, lib, fencedRoot, budget)
      .filter((raw) => insideProject(fencedRoot, raw.path)).map((raw) => indexDoc(raw, lib)).filter((item): item is IndexedDoc => item !== null)
      : getIndexed(root, lib)
    const indexed = candidates.filter((item) => {
      if (!scope || !fencedRoot) return true
      const dir = relative(fencedRoot, dirname(item.doc.path)).split(sep).join('/')
      return dir === scope.folderPath || (scope.folderRecursive === true && (scope.folderPath === '' || dir.startsWith(`${scope.folderPath}/`)))
    })
    total += indexed.length
    if (!q) {
      docs.push(...indexed.map((d) => d.doc))
      continue
    }
    // 词频表：latin 精确命中；CJK run 按 bigram 覆盖率（60%，单个 bigram 须全中）
    type Scored = { item: IndexedDoc; score: number; matchedAll: number }
    const scored: Scored[] = []
    for (const item of indexed) {
      let ok = true
      let score = 0
      let matchedTerms = 0
      const totalTerms = latin.length + runs.length
      for (const t of latin) {
        const tf = item.tokens.get(t)
        if (!tf) {
          ok = false
          break
        }
        score += tf
        matchedTerms += 1
      }
      if (ok) {
        for (const bigrams of runs) {
          let matched = 0
          let tfSum = 0
          for (const b of bigrams) {
            const tf = item.tokens.get(b)
            if (tf) {
              matched += 1
              tfSum += tf
            }
          }
          const required = bigrams.length === 1 ? 1 : Math.ceil(bigrams.length * 0.6)
          if (matched < required) {
            ok = false
            break
          }
          score += tfSum
          matchedTerms += 1
        }
      }
      if (!ok) continue
      // 标题命中加权
      const titleLower = item.doc.title.toLowerCase()
      if (highlightTerms.some((t) => titleLower.includes(t))) score += 8
      if (item.doc.path.toLowerCase().includes(q)) score += 3
      scored.push({ item, score, matchedAll: totalTerms > 0 ? matchedTerms / totalTerms : 0 })
    }
    if (scored.length > 0) {
      // IDF 修饰：稀有 bigram 贡献更大
      const allTerms = [...latin, ...runs.flat()]
      const df = new Map<string, number>()
      for (const t of allTerms) {
        let n = 0
        for (const item of indexed) if (item.tokens.has(t)) n += 1
        df.set(t, Math.max(n, 1))
      }
      const N = indexed.length
      for (const s of scored) {
        let idfScore = 0
        for (const t of allTerms) {
          const tf = s.item.tokens.get(t) ?? 0
          const dfVal = df.get(t)
          if (dfVal !== undefined) idfScore += tf * Math.log(1 + N / dfVal)
        }
        hits.push({
          doc: s.item.doc,
          score: (idfScore + s.score * 0.01) * (0.5 + s.matchedAll * 0.5),
          snippet: snippet(s.item.text, highlightTerms)
        })
      }
    }
  }

  if (q) {
    hits.sort((a, b) => b.score - a.score || b.doc.mtime - a.doc.mtime)
    return { ok: true, hits: hits.slice(0, 80), docs: [], totalDocs: total, elapsedMs: Date.now() - t0, ...(scope && budget ? { scopeApplied: true as const, complete: !budget.reason, hasMore: hits.length > 80, ...(budget.reason ? { truncationReason: budget.reason } : {}) } : {}) }
  }
  docs.sort((a, b) => b.mtime - a.mtime)
  return { ok: true, hits: [], docs: docs.slice(0, 300), totalDocs: total, elapsedMs: Date.now() - t0 }
}

export interface KbBrowseIndex { root: string; library: KbLibrary | 'all'; docs: KbDoc[]; folders: string[]; snapshotAt: number; complete: boolean; truncationReason?: BrowseLimitReason }
export function kbBrowseIndex(root: string, library: KbLibrary | 'all'): KbBrowseIndex {
  const fencedRoot = realpathSync(resolve(root))
  const libs: KbLibrary[] = library === 'all' ? ['requirements', 'spec', 'wiki', 'archive', 'notes'] : [library]
  const budget: BrowseBudget = { entries: 0, reads: 0, bytes: 0 }
  const seen = new Set<string>(), docs: KbDoc[] = [], folders = new Set<string>()
  for (const lib of libs) {
    for (const raw of collectLibrary(fencedRoot, lib, fencedRoot, budget)) {
      try {
        const real = realpathSync(raw.path)
        if (!insideProject(fencedRoot, raw.path)) continue
        const key = `${lib}:${process.platform === 'win32' ? real.toLowerCase() : real}`
        if (seen.has(key)) continue
        const st = statSync(raw.path)
        seen.add(key)
        docs.push({ id: `${lib}:${raw.path}`, library: lib, path: raw.path, name: basename(raw.path), group: raw.group, title: raw.title || basename(raw.path), size: st.size, mtime: st.mtimeMs, synthetic: raw.synthetic })
        const parts = relative(fencedRoot, dirname(raw.path)).split(sep).filter(Boolean)
        for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'))
      } catch { budget.reason ??= 'unreadable' }
    }
  }
  docs.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path) || a.library.localeCompare(b.library))
  return { root: fencedRoot, library, docs, folders: [...folders].sort((a, b) => a.localeCompare(b)), snapshotAt: Date.now(), complete: !budget.reason, ...(budget.reason ? { truncationReason: budget.reason } : {}) }
}
export function kbBrowse(root: string, input: KbBrowseInput, index = kbBrowseIndex(root, input.library ?? 'all')): KbBrowseSuccess {
  const selected = input.folderPath
  const matching = selected === undefined ? index.docs : index.docs.filter((doc) => {
    const dir = relative(index.root, dirname(doc.path)).split(sep).join('/')
    return dir === selected || (input.folderRecursive === true && (selected === '' || dir.startsWith(`${selected}/`)))
  })
  const page = input.page ?? 1, pageSize = input.pageSize ?? 30
  const offset = (page - 1) * pageSize
  return { ok: true, docs: matching.slice(offset, offset + pageSize), page, pageSize, totalDocs: matching.length, hasMore: offset + pageSize < matching.length, folders: index.folders, snapshotAt: index.snapshotAt, complete: index.complete, ...(index.truncationReason ? { truncationReason: index.truncationReason } : {}) }
}

export function kbDocById(root: string, id: string): KbDoc | null {
  const idx = id.indexOf(':')
  if (idx <= 0) return null
  const lib = id.slice(0, idx) as KbLibrary
  const path = id.slice(idx + 1)
  if (!['requirements', 'spec', 'wiki', 'archive', 'notes'].includes(lib)) return null
  const found = getIndexed(root, lib).find((d) => d.doc.path === path)
  return found?.doc ?? null
}

/* ---------------- 问答历史（userData 持久化） ---------------- */

const MAX_QA_HISTORY = 100

let qaHistoryFile: string | null = null

function qaFilePath(app: { getPath: (name: 'userData') => string }): string {
  if (!qaHistoryFile) qaHistoryFile = join(app.getPath('userData'), 'kb-qa-history.json')
  return qaHistoryFile
}

export function qaHistoryList(app: { getPath: (name: 'userData') => string }): KbQaEntry[] {
  try {
    const p = qaFilePath(app)
    if (!existsSync(p)) return []
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown
    return Array.isArray(raw) ? (raw as KbQaEntry[]) : []
  } catch {
    return []
  }
}

export function qaHistorySave(app: { getPath: (name: 'userData') => string }, entry: KbQaEntry): KbQaEntry[] {
  const list = [entry, ...qaHistoryList(app)].slice(0, MAX_QA_HISTORY)
  try {
    writeFileSync(qaFilePath(app), JSON.stringify(list, null, 2), 'utf-8')
  } catch {
    // best-effort
  }
  return list
}

export function qaHistoryClear(app: { getPath: (name: 'userData') => string }): void {
  try {
    const p = qaFilePath(app)
    if (existsSync(p)) rmSync(p)
  } catch {
    // ignore
  }
}
