import { useMemo } from 'react'
import type { JSX } from 'react'

/**
 * 轻量语法高亮 —— 面向产物预览的"够用即可"实现：
 * 关键字 / 字符串 / 注释 / 数字着色，React 节点输出（无 innerHTML 注入面）。
 * 支持 ts/tsx/js/jsx/py/sh/yaml/json/toml/sql/css/html 的通用子集。
 */

type Tok = { t: 'kw' | 'str' | 'num' | 'com' | 'bool' | 'plain'; s: string }

const KEYWORDS: Record<string, string[]> = {
  js: 'const let var function return if else for while class new extends import export from default async await try catch finally throw typeof instanceof this super switch case break continue do delete in of yield static get set void undefined'.split(' '),
  ts: 'interface type enum implements public private protected readonly namespace declare abstract as is keyof infer satisfies override'.split(' '),
  py: 'def class return if elif else for while import from as with try except finally raise lambda pass break continue global nonlocal assert yield del async await match case self None True False and or not in is'.split(' '),
  sh: 'if then else elif fi for while do done case esac function return exit local export echo cd set'.split(' '),
  sql: 'select from where insert into values update set delete create table drop alter join left right inner outer on group by order limit offset as and or not null distinct having union index primary key foreign references'.split(' '),
  css: 'important media supports keyframes import from to and not only screen'.split(' ')
}

KEYWORDS.ts = [...KEYWORDS.js, ...KEYWORDS.ts]
KEYWORDS.jsx = KEYWORDS.ts
KEYWORDS.tsx = KEYWORDS.ts
KEYWORDS.json = ['true', 'false', 'null']

function langOf(ext: string): string {
  const e = ext.toLowerCase()
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(e)) return 'ts'
  if (e === '.py') return 'py'
  if (['.sh', '.ps1', '.cmd', '.bat'].includes(e)) return 'sh'
  if (['.yaml', '.yml', '.toml', '.ini', '.cfg', '.env'].includes(e)) return 'yaml'
  if (e === '.sql') return 'sql'
  if (e === '.css' || e === '.html') return 'css'
  return 'plain'
}

function tokenizeLine(line: string, lang: string): Tok[] {
  const toks: Tok[] = []
  const kws = new Set(KEYWORDS[lang] ?? [])
  const hashComment = ['py', 'sh', 'yaml'].includes(lang)
  // match order matters: comment, string, number, word
  const re = new RegExp(
    [
      hashComment ? '#.*' : '(#.*|//.*|/\\*[\\s\\S]*?\\*/|<!--.*?-->)',
      '("(?:[^"\\\\]|\\\\.)*"?|\'(?:[^\'\\\\]|\\\\.)*\'?|`(?:[^`\\\\]|\\\\.)*`?)',
      '(\\b\\d+(?:\\.\\d+)?\\b)',
      '([A-Za-z_$][\\w$-]*)'
    ].join('|'),
    'g'
  )
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) toks.push({ t: 'plain', s: line.slice(last, m.index) })
    if (m[1]) toks.push({ t: 'com', s: m[1] })
    else if (m[2]) toks.push({ t: 'str', s: m[2] })
    else if (m[3]) toks.push({ t: 'num', s: m[3] })
    else if (m[4]) {
      const w = m[4]
      if (kws.has(w)) toks.push({ t: 'kw', s: w })
      else if (['true', 'false', 'null', 'None', 'True', 'False'].includes(w)) toks.push({ t: 'bool', s: w })
      else toks.push({ t: 'plain', s: w })
    }
    last = re.lastIndex
  }
  if (last < line.length) toks.push({ t: 'plain', s: line.slice(last) })
  return toks
}

const CLS: Record<Tok['t'], string> = {
  kw: 'text-violet-300',
  str: 'text-emerald-300',
  num: 'text-sky-300',
  com: 'text-mist-600 italic',
  bool: 'text-orange-300',
  plain: ''
}

export function CodeView({ content, ext }: { content: string; ext: string }): JSX.Element {
  const lang = langOf(ext)
  const lines = useMemo(() => content.split('\n').map((l) => (lang === 'plain' ? [] : tokenizeLine(l, lang))), [content, lang])

  if (lang === 'plain') {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-mist-300">{content}</pre>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-[12px] leading-5">
      {lines.map((toks, i) => (
        <div key={i} className="flex">
          <span className="w-9 shrink-0 select-none pr-2 text-right text-[10px] text-mist-700">{i + 1}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">
            {toks.length === 0 ? (
              <span> </span>
            ) : (
              toks.map((tk, j) => (
                <span key={j} className={CLS[tk.t]}>
                  {tk.s}
                </span>
              ))
            )}
          </span>
        </div>
      ))}
    </div>
  )
}
