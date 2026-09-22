import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, statSync } from 'fs'

/**
 * 知识库 MCP stdio 服务器（独立运行，零依赖）。
 * 面板把这份脚本写到 userData 下，AI 编码工具（Claude Code / Codex / ZCode…）
 * 以 stdio 子进程方式拉起——检索在进程内倒排索引上完成，无网络、无 embedding，
 * 单次查询毫秒级。这解决了远程/重型 MCP 知识库"检索动辄数秒"的问题。
 *
 * 注意：本文件是嵌入模板（写入磁盘时原样输出），服务端代码不能使用反引号与 ${}。
 */
export function kbMcpScript(): string {
  return KB_MCP_SCRIPT
}

export function kbMcpScriptPath(): string {
  return join(app.getPath('userData'), 'tpanel-kb-mcp.cjs')
}

/* ---------------- 安装与注册 ---------------- */

export interface KbMcpInstallResult {
  ok: boolean
  error?: string
  scriptPath: string
  /** 已合并写入的项目级 Claude Code MCP 配置 */
  claudeMcpJson: string | null
  /** Codex ~/.codex/config.toml 是否已自动写入 */
  codexWritten: boolean
  codexSnippet: string
  zcodeCommand: string
  genericSnippet: string
}

const SERVER_KEY = 'trellis-panel-kb'

function tomlSnippet(scriptPath: string, root: string): string {
  // TOML 字面量字符串（单引号）不处理转义——Windows 反斜杠路径安全
  return ['[mcp_servers.' + SERVER_KEY + ']', "command = 'node'", "args = ['" + scriptPath + "', '--root', '" + root + "']"].join('\n')
}

function ensureCodexConfig(scriptPath: string, root: string): boolean {
  try {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
    if (!home) return false
    const cfgPath = join(home, '.codex', 'config.toml')
    const header = '[mcp_servers.' + SERVER_KEY + ']'
    const block = tomlSnippet(scriptPath, root)
    let raw = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8') : ''
    if (raw.includes(header)) {
      // 替换已存在的整节（到下一个 [ 节头或文件尾）
      const re = new RegExp('\\[mcp_servers\\.' + SERVER_KEY + '\\][\\s\\S]*?(?=\\n\\[|\\s*$)', 'g')
      raw = raw.replace(re, block)
    } else {
      raw = (raw.endsWith('\n') || raw === '' ? raw : raw + '\n') + block + '\n'
    }
    writeFileSync(cfgPath, raw, 'utf-8')
    return true
  } catch {
    return false
  }
}

export function kbMcpInstall(root: string): KbMcpInstallResult {
  const scriptPath = kbMcpScriptPath()
  try {
    writeFileSync(scriptPath, kbMcpScript(), 'utf-8')
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message,
      scriptPath,
      claudeMcpJson: null,
      codexWritten: false,
      codexSnippet: tomlSnippet(scriptPath, root),
      zcodeCommand: 'zcode mcp add ' + SERVER_KEY + ' -- node "' + scriptPath + '" --root "' + root + '"',
      genericSnippet: genericSnippet(scriptPath, root)
    }
  }

  // 项目级 Claude Code 标准配置（.mcp.json，随仓库共享给团队）
  let claudeWritten: string | null = null
  try {
    const mcpJsonPath = join(root, '.mcp.json')
    let doc: { mcpServers?: Record<string, unknown> } = {}
    try {
      doc = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'))
    } catch {
      doc = {}
    }
    doc.mcpServers = { ...(doc.mcpServers ?? {}), [SERVER_KEY]: { command: 'node', args: [scriptPath, '--root', root] } }
    writeFileSync(mcpJsonPath, JSON.stringify(doc, null, 2) + '\n', 'utf-8')
    claudeWritten = mcpJsonPath
  } catch {
    // 只读目录等情况——降级为复制片段
  }

  const codexWritten = ensureCodexConfig(scriptPath, root)
  return {
    ok: true,
    scriptPath,
    claudeMcpJson: claudeWritten,
    codexWritten,
    codexSnippet: tomlSnippet(scriptPath, root),
    zcodeCommand: 'zcode mcp add ' + SERVER_KEY + ' -- node "' + scriptPath + '" --root "' + root + '"',
    genericSnippet: genericSnippet(scriptPath, root)
  }
}

function genericSnippet(scriptPath: string, root: string): string {
  return JSON.stringify({ mcpServers: { [SERVER_KEY]: { command: 'node', args: [scriptPath, '--root', root] } } }, null, 2)
}

export interface KbMcpStatus {
  installed: boolean
  scriptPath: string
  mtime: number
  /** 项目是否已配置 .mcp.json */
  claudeConfigured: boolean
}

export function kbMcpStatus(root: string | null): KbMcpStatus {
  const p = kbMcpScriptPath()
  let mtime = 0
  try {
    mtime = statSync(p).mtimeMs
  } catch {
    // 未安装
  }
  let claudeConfigured = false
  if (root) {
    try {
      const doc = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf-8'))
      claudeConfigured = !!(doc?.mcpServers?.[SERVER_KEY])
    } catch {
      claudeConfigured = false
    }
  }
  return { installed: mtime > 0, scriptPath: p, mtime, claudeConfigured }
}

const KB_MCP_SCRIPT = `#!/usr/bin/env node
/* tpanel-kb-mcp —— Trellis Panel 知识库 MCP stdio 服务器（零依赖，Node >= 16）
 * 用法: node tpanel-kb-mcp.cjs --root <项目根目录>
 * 工具: kb_search / kb_read / kb_context / kb_overview
 */
'use strict'
const fs = require('fs')
const path = require('path')

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2)
let ROOT = process.cwd()
let MAX_CHARS = 8000
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root' && argv[i + 1]) ROOT = path.resolve(argv[i + 1])
  if (argv[i] === '--max-chars' && argv[i + 1]) MAX_CHARS = Math.max(1000, Number(argv[i + 1]) || 8000)
}

/* ---------- 分词（与面板内一致：拉丁词 + CJK 二元 bigram） ---------- */
var STOP = {}
'the and for with that this from into are was not you your can has have will would should could than then them they were been being its our out about over all also'.split(' ').forEach(function (w) { STOP[w] = 1 })

function addToken(map, t) { map.set(t, (map.get(t) || 0) + 1) }
function tokenize(text, out) {
  var lower = String(text).toLowerCase()
  var m
  var reWord = /[a-z][a-z0-9_\\-]{1,}/g
  while ((m = reWord.exec(lower)) !== null) {
    var t = m[0].replace(/^-+|-+$/g, '')
    if (t.length >= 2 && !STOP[t]) addToken(out, t)
  }
  var reCjk = /[\\u4e00-\\u9fff]+/g
  while ((m = reCjk.exec(lower)) !== null) {
    var s = m[0]
    if (s.length === 1) { addToken(out, s); continue }
    for (var i = 0; i < s.length - 1; i++) addToken(out, s.slice(i, i + 2))
  }
}

function parseQuery(query) {
  var latin = []
  var runs = []
  var lower = String(query).toLowerCase()
  var m
  var reWord = /[a-z][a-z0-9_\\-]{1,}/g
  while ((m = reWord.exec(lower)) !== null) {
    var t = m[0].replace(/^-+|-+$/g, '')
    if (t.length >= 2 && !STOP[t]) latin.push(t)
  }
  var reCjk = /[\\u4e00-\\u9fff]+/g
  while ((m = reCjk.exec(lower)) !== null) {
    var s = m[0]
    if (s.length === 1) { runs.push([s]); continue }
    var bigrams = []
    for (var i = 0; i < s.length - 1; i++) bigrams.push(s.slice(i, i + 2))
    runs.push(bigrams)
  }
  return { latin: latin, runs: runs }
}

/* ---------- 语料发现（spec / requirements / wiki / archive） ---------- */
function isDir(p) { try { return fs.statSync(p).isDirectory() } catch (e) { return false } }
function readText(p, maxBytes) {
  try {
    var st = fs.statSync(p)
    if (st.size > (maxBytes || 512 * 1024)) return null
    var c = fs.readFileSync(p, 'utf8')
    if (c.charCodeAt(0) === 0xfeff) c = c.slice(1)
    return c
  } catch (e) { return null }
}
var TEXT_EXTS = { '.md': 1, '.markdown': 1, '.txt': 1 }
function walkFiles(dir, maxDepth, skip, acc, depth) {
  if (depth > maxDepth || acc.length > 4000 || !isDir(dir)) return
  var names
  try { names = fs.readdirSync(dir) } catch (e) { return }
  names.sort()
  for (var i = 0; i < names.length; i++) {
    var name = names[i]
    if (name.charAt(0) === '.') continue
    var p = path.join(dir, name)
    if (isDir(p)) { if (!skip[name]) walkFiles(p, maxDepth, skip, acc, depth + 1) }
    else if (TEXT_EXTS[path.extname(name).toLowerCase()]) acc.push(p)
  }
}
function firstHeading(text) {
  var lines = text.split(/\\r?\\n/).slice(0, 30)
  for (var i = 0; i < lines.length; i++) {
    var mMatch = /^#\\s+(.{2,80})\\s*$/.exec(lines[i].trim())
    if (mMatch) return mMatch[1]
  }
  return null
}
function relSlash(from, p) { return path.relative(from, p).split(path.sep).join('/') }

function collectRaw(lib) {
  var out = []
  if (lib === 'spec') {
    var files = []
    walkFiles(path.join(ROOT, '.trellis', 'spec'), 6, {}, files, 0)
    for (var i = 0; i < files.length; i++) {
      var text = readText(files[i])
      if (text === null) continue
      var rel = relSlash(path.join(ROOT, '.trellis', 'spec'), files[i])
      var group = rel.indexOf('/') >= 0 ? rel.slice(0, rel.lastIndexOf('/')) : '(root)'
      out.push({ path: files[i], title: firstHeading(text) || path.basename(files[i]), group: group, text: text })
    }
  } else if (lib === 'wiki') {
    var roots = ['README.md', 'readme.md', 'AGENTS.md', 'CLAUDE.md', 'ARCHITECTURE.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'DESIGN.md']
    for (var r = 0; r < roots.length; r++) {
      var p1 = path.join(ROOT, roots[r])
      if (!fs.existsSync(p1)) continue
      var t1 = readText(p1)
      if (t1 === null) continue
      out.push({ path: p1, title: firstHeading(t1) || roots[r], group: '(repo-root)', text: t1 })
    }
    var subs = ['docs', 'doc', 'wiki', 'documentation']
    var skip = { node_modules: 1, '.git': 1, out: 1, dist: 1, release: 1, coverage: 1, build: 1 }
    for (var s = 0; s < subs.length; s++) {
      var subFiles = []
      walkFiles(path.join(ROOT, subs[s]), 5, skip, subFiles, 0)
      for (var j = 0; j < subFiles.length; j++) {
        var t2 = readText(subFiles[j])
        if (t2 === null) continue
        var rel2 = relSlash(path.join(ROOT, subs[s]), subFiles[j])
        out.push({ path: subFiles[j], title: firstHeading(t2) || path.basename(subFiles[j]), group: rel2.indexOf('/') >= 0 ? subs[s] + '/' + rel2.slice(0, rel2.lastIndexOf('/')) : subs[s], text: t2 })
      }
    }
  } else if (lib === 'notes') {
    var noteFiles = []
    walkFiles(path.join(ROOT, '.trellis', 'notes'), 3, {}, noteFiles, 0)
    for (var n = 0; n < noteFiles.length; n++) {
      var t3 = readText(noteFiles[n])
      if (t3 === null) continue
      var rel3 = relSlash(path.join(ROOT, '.trellis', 'notes'), noteFiles[n])
      out.push({ path: noteFiles[n], title: firstHeading(t3) || path.basename(noteFiles[n], '.md'), group: rel3.indexOf('/') >= 0 ? rel3.slice(0, rel3.lastIndexOf('/')) : '(notes)', text: t3 })
    }
  } else {
    // requirements / archive：任务目录里的需求文档 + task.json 提炼
    var roots2 = lib === 'requirements'
      ? [path.join(ROOT, '.trellis', 'tasks')]
      : [path.join(ROOT, '.trellis', 'archive'), path.join(ROOT, '.trellis', 'tasks', 'archive')]
    var want = { 'prd.md': 1, 'PRD.md': 1, 'requirement.md': 1, 'requirements.md': 1, 'design.md': 1, 'README.md': 1 }
    for (var ri = 0; ri < roots2.length; ri++) {
      walkTaskDirs(roots2[ri], lib, want, out, 0)
    }
  }
  return out
}
function walkTaskDirs(dir, lib, want, out, depth) {
  if (depth > 4 || !isDir(dir)) return
  var names
  try { names = fs.readdirSync(dir) } catch (e) { return }
  if (names.indexOf('task.json') >= 0) {
    var dirName = path.basename(dir)
    for (var w in want) {
      if (!want.hasOwnProperty(w)) continue
      var pf = path.join(dir, w)
      if (!fs.existsSync(pf)) continue
      var tf = readText(pf)
      if (tf === null) continue
      out.push({ path: pf, title: firstHeading(tf) || dirName + '/' + w, group: dirName, text: tf })
      break
    }
    var raw = readText(path.join(dir, 'task.json'), 256 * 1024)
    if (raw) {
      try {
        var o = JSON.parse(raw)
        if (o && typeof o === 'object') {
          var subs = Array.isArray(o.subtasks) ? o.subtasks.join('\\n') : ''
          var body = [String(o.description || ''), String(o.notes || ''), subs].filter(Boolean).join('\\n\\n')
          if (body.trim()) out.push({ path: path.join(dir, 'task.json'), title: String(o.title || dirName), group: dirName, text: String(o.title || '') + '\\n' + body, synthetic: true })
        }
      } catch (e) {}
    }
    return
  }
  for (var i = 0; i < names.length; i++) {
    var name = names[i]
    if (name.charAt(0) === '.') continue
    if (lib === 'requirements' && name === 'archive') continue
    walkTaskDirs(path.join(dir, name), lib, want, out, depth + 1)
  }
}

/* ---------- 索引（按 mtime+size 增量缓存） ---------- */
var cache = new Map()
function indexLib(lib) {
  var raws = collectRaw(lib)
  var result = []
  var fresh = {}
  for (var i = 0; i < raws.length; i++) {
    var raw = raws[i]
    var st
    try { st = fs.statSync(raw.path) } catch (e) { continue }
    fresh[raw.path] = 1
    var cached = cache.get(raw.path)
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) { if (cached.item) result.push(cached.item); continue }
    var tokens = new Map()
    var title = raw.title || path.basename(raw.path)
    tokenize(title, tokens)
    tokenize(raw.text, tokens)
    var item = { doc: { path: raw.path, title: title, library: lib, group: raw.group, size: st.size, mtime: st.mtimeMs, synthetic: !!raw.synthetic }, tokens: tokens, text: raw.text.length > 20000 ? raw.text.slice(0, 20000) : raw.text }
    cache.set(raw.path, { mtime: st.mtimeMs, size: st.size, item: item })
    result.push(item)
  }
  for (var key of Array.from(cache.keys())) {
    if (!fresh[key] && !fs.existsSync(key)) cache.delete(key)
  }
  return result
}

/* ---------- 检索（AND + CJK run 60% bigram 覆盖 + IDF） ---------- */
function snippet(text, terms) {
  var lower = text.toLowerCase()
  var bestStart = 0
  var bestScore = -1
  for (var start = 0; start < Math.min(text.length, 8000); start += 400) {
    var window = lower.slice(start, start + 240)
    var sc = 0
    for (var i = 0; i < terms.length; i++) if (window.indexOf(terms[i]) >= 0) sc++
    if (sc > bestScore) { bestScore = sc; bestStart = start }
    if (bestScore >= terms.length) break
  }
  var raw = text.slice(bestStart, bestStart + 240).replace(/\\s+/g, ' ').trim()
  for (var j = 0; j < terms.length; j++) {
    var t = terms[j]
    if (!t) continue
    var esc = t.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')
    raw = raw.replace(new RegExp('(' + esc + ')', 'gi'), '\\u0000$1\\u0001')
  }
  return raw
}

function doSearch(libs, query, limit) {
  var t0 = Date.now()
  var pq = parseQuery(query)
  var highlight = pq.latin.concat.apply(pq.latin, pq.runs)
  var hits = []
  var total = 0
  for (var li = 0; li < libs.length; li++) {
    var indexed = indexLib(libs[li])
    total += indexed.length
    var allTerms = pq.latin.concat.apply(pq.latin, pq.runs)
    var df = new Map()
    for (var di = 0; di < allTerms.length; di++) {
      var t0d = allTerms[di]
      var n = 0
      for (var ii = 0; ii < indexed.length; ii++) if (indexed[ii].tokens.has(t0d)) n++
      df.set(t0d, Math.max(n, 1))
    }
    var N = indexed.length
    for (var k = 0; k < indexed.length; k++) {
      var item = indexed[k]
      var ok = true
      var score = 0
      var matchedTerms = 0
      var totalTerms = pq.latin.length + pq.runs.length
      for (var a = 0; a < pq.latin.length && ok; a++) {
        var tf = item.tokens.get(pq.latin[a])
        if (!tf) { ok = false; break }
        score += tf
        matchedTerms++
      }
      for (var b = 0; b < pq.runs.length && ok; b++) {
        var bigrams = pq.runs[b]
        var matched = 0
        var tfSum = 0
        for (var c = 0; c < bigrams.length; c++) {
          var tb = item.tokens.get(bigrams[c])
          if (tb) { matched++; tfSum += tb }
        }
        var required = bigrams.length === 1 ? 1 : Math.ceil(bigrams.length * 0.6)
        if (matched < required) { ok = false; break }
        score += tfSum
        matchedTerms++
      }
      if (!ok) continue
      var titleLower = item.doc.title.toLowerCase()
      var hitTitle = false
      for (var h = 0; h < highlight.length; h++) if (titleLower.indexOf(highlight[h]) >= 0) { hitTitle = true; break }
      if (hitTitle) score += 8
      var idfScore = 0
      for (var d2 = 0; d2 < allTerms.length; d2++) {
        var tf2 = item.tokens.get(allTerms[d2]) || 0
        idfScore += tf2 * Math.log(1 + N / df.get(allTerms[d2]))
      }
      hits.push({ path: item.doc.path, title: item.doc.title, library: item.doc.library, group: item.doc.group, score: +((idfScore + score * 0.01) * (0.5 + (totalTerms ? matchedTerms / totalTerms : 0) * 0.5)).toFixed(2), snippet: snippet(item.text, highlight) })
    }
  }
  hits.sort(function (x, y) { return y.score - x.score })
  return { hits: hits.slice(0, limit || 10), totalDocs: total, elapsedMs: Date.now() - t0 }
}

function cleanMark(s) { return String(s).replace(/[\\u0000\\u0001]/g, '') }

/* ---------- 工具实现 ---------- */
var READ_EXTS = { '.md': 1, '.markdown': 1, '.txt': 1, '.json': 1, '.jsonl': 1, '.yaml': 1, '.yml': 1, '.toml': 1, '.py': 1, '.ts': 1, '.tsx': 1, '.js': 1, '.mjs': 1, '.cjs': 1, '.sh': 1, '.ps1': 1, '.html': 1, '.css': 1, '.sql': 1 }

function safeReadFile(relOrAbs, maxChars) {
  var p = path.isAbsolute(relOrAbs) ? path.resolve(relOrAbs) : path.resolve(ROOT, relOrAbs)
  var rel = path.relative(ROOT, p)
  if (!rel || rel.slice(0, 2) === '..' || path.isAbsolute(rel)) return { error: 'path outside project root' }
  if (!READ_EXTS[path.extname(p).toLowerCase()]) return { error: 'unsupported extension' }
  var text = readText(p, 5 * 1024 * 1024)
  if (text === null) return { error: 'unreadable or too large' }
  var total = text.length
  var cut = text.slice(0, maxChars || MAX_CHARS)
  return { path: rel.split(path.sep).join('/'), totalChars: total, truncated: total > cut.length, content: cut }
}

var TOOLS = [
  {
    name: 'kb_search',
    description: 'Search the Trellis knowledge base (requirements PRDs / team spec / project wiki / archived tasks / personal notes). Local inverted index, millisecond latency. Use before implementing anything to find related specs, past PRDs and conventions. CJK + English mixed queries supported.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keywords, e.g. "退货审核 spec" or "binding validation"' },
        library: { type: 'string', enum: ['all', 'requirements', 'spec', 'wiki', 'archive', 'notes'], description: 'which library to search (default all)' },
        limit: { type: 'number', description: 'max hits, default 10' }
      },
      required: ['query']
    }
  },
  {
    name: 'kb_read',
    description: 'Read a knowledge base document by path (as returned by kb_search). Returns markdown/text content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'document path (absolute or project-relative)' },
        maxChars: { type: 'number', description: 'max characters to return, default 8000' }
      },
      required: ['path']
    }
  },
  {
    name: 'kb_context',
    description: 'Build a ready-to-use context pack for a topic or task: searches spec/wiki/requirements/archive and returns the most relevant excerpts in one markdown blob. Use at planning time or before touching an unfamiliar area.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'topic keywords, e.g. "退货 拆零 台账"' },
        task_dir: { type: 'string', description: 'optional task dir name under .trellis/tasks to include its PRD' }
      },
      required: ['topic']
    }
  },
  {
    name: 'kb_overview',
    description: 'Overview of the knowledge base: document counts per library and the top-level spec tree. Call once to discover what knowledge exists.',
    inputSchema: { type: 'object', properties: {} }
  }
]

function toolKbSearch(args) {
  var lib = args.library || 'all'
  var libs = lib === 'all' ? ['requirements', 'spec', 'wiki', 'archive', 'notes'] : [lib]
  var r = doSearch(libs, String(args.query || ''), Math.min(Math.max(Number(args.limit) || 10, 1), 30))
  if (r.hits.length === 0) return { text: 'No hits for "' + args.query + '" (indexed ' + r.totalDocs + ' docs in ' + r.elapsedMs + 'ms). Try shorter keywords.' }
  var lines = ['KB search: "' + args.query + '" — ' + r.hits.length + ' hits (' + r.totalDocs + ' docs indexed, ' + r.elapsedMs + 'ms)']
  for (var i = 0; i < r.hits.length; i++) {
    var h = r.hits[i]
    lines.push((i + 1) + '. [' + h.library + '] ' + h.title + '  (score ' + h.score + ')')
    lines.push('   path: ' + h.path.split(path.sep).join('/'))
    lines.push('   ' + cleanMark(h.snippet).slice(0, 200))
  }
  return { text: lines.join('\\n') }
}

function toolKbRead(args) {
  var r = safeReadFile(String(args.path || ''), Number(args.maxChars) || MAX_CHARS)
  if (r.error) return { text: 'kb_read error: ' + r.error }
  var head = '# ' + r.path + (r.truncated ? ' (truncated at ' + (r.content ? r.content.length : 0) + '/' + r.totalChars + ' chars)' : '')
  return { text: head + '\\n\\n' + (r.content || '') }
}

function toolKbOverview() {
  var libs = ['requirements', 'spec', 'wiki', 'archive', 'notes']
  var lines = ['Trellis knowledge base overview (' + ROOT + ')']
  var specTree = {}
  for (var i = 0; i < libs.length; i++) {
    var docs = indexLib(libs[i])
    lines.push('- ' + libs[i] + ': ' + docs.length + ' docs')
    if (libs[i] === 'spec') {
      for (var j = 0; j < docs.length; j++) {
        var g = docs[j].doc.group
        specTree[g] = (specTree[g] || 0) + 1
      }
    }
  }
  var groups = Object.keys(specTree).sort()
  if (groups.length) {
    lines.push('spec groups:')
    for (var g2 = 0; g2 < groups.length; g2++) lines.push('  - ' + groups[g2] + ' (' + specTree[groups[g2]] + ')')
  }
  return { text: lines.join('\\n') }
}

function toolKbContext(args) {
  var topic = String(args.topic || '')
  var libs = ['spec', 'wiki', 'requirements', 'archive', 'notes']
  var r = doSearch(libs, topic, 8)
  var out = ['# Context pack: ' + topic, '']
  var perLib = {}
  for (var i = 0; i < r.hits.length; i++) {
    var h = r.hits[i]
    if (perLib[h.library]) continue
    perLib[h.library] = 1
    var read = safeReadFile(h.path, 4000)
    if (read.error) continue
    out.push('## [' + h.library + '] ' + h.title)
    out.push('source: ' + read.path)
    out.push(read.content)
    out.push('')
  }
  if (out.length === 2) out.push('(no KB hits for this topic)')
  if (args.task_dir) {
    var td = path.join(ROOT, '.trellis', 'tasks', String(args.task_dir))
    var prd = safeReadFile(path.join(td, 'prd.md'), 6000)
    if (!prd.error) {
      out.push('## [task-prd] ' + args.task_dir)
      out.push(prd.content)
    }
  }
  return { text: out.join('\\n') }
}

function callTool(name, args) {
  try {
    if (name === 'kb_search') return toolKbSearch(args || {})
    if (name === 'kb_read') return toolKbRead(args || {})
    if (name === 'kb_context') return toolKbContext(args || {})
    if (name === 'kb_overview') return toolKbOverview()
    return { isError: true, text: 'unknown tool: ' + name }
  } catch (e) {
    return { isError: true, text: 'tool error: ' + (e && e.message ? e.message : String(e)) }
  }
}

/* ---------- MCP JSON-RPC over stdio（按行分隔） ---------- */
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n') }

function handle(msg) {
  var method = msg.method
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'trellis-panel-kb', version: '1.0.0' } } })
    return
  }
  if (method === 'notifications/initialized' || (method && method.slice(0, 13) === 'notifications')) return
  if (method === 'ping') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return }
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } }); return }
  if (method === 'tools/call') {
    var params = msg.params || {}
    var r = callTool(params.name, params.arguments)
    send({
      jsonrpc: '2.0', id: msg.id,
      result: { content: [{ type: 'text', text: r.text }], isError: !!r.isError }
    })
    return
  }
  if (method === 'resources/list') { send({ jsonrpc: '2.0', id: msg.id, result: { resources: [] } }); return }
  if (method === 'prompts/list') { send({ jsonrpc: '2.0', id: msg.id, result: { prompts: [] } }); return }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + method } })
}

var buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', function (d) {
  buf += d
  var idx
  while ((idx = buf.indexOf('\\n')) >= 0) {
    var line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    try { handle(JSON.parse(line)) } catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
  }
})
process.stdin.on('end', function () { process.exit(0) })
process.stderr.write('trellis-panel-kb mcp ready, root=' + ROOT + '\\n')
`
