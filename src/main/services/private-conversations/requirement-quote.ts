import { Lexer, type Token, type Tokens } from 'marked'

const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()
function entities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value.replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (original, key: string) => {
    if (!key.startsWith('#')) return named[key.toLowerCase()] ?? original
    const point = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10)
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : original
  })
}
function visible(tokens: readonly Token[], depth = 0): string {
  if (depth > 64) throw new Error('文档嵌套过深，请缩小选区。')
  return tokens.map(token => {
    switch (token.type) {
      case 'list': return (token as Tokens.List).items.map(item => visible(item.tokens, depth + 1)).join('\n') + '\n'
      case 'table': {
        const table = token as Tokens.Table
        return [table.header, ...table.rows].map(row => row.map(cell => visible(cell.tokens, depth + 1)).join('\t')).join('\n') + '\n'
      }
      case 'heading': case 'paragraph': case 'blockquote': return visible((token as Tokens.Paragraph).tokens, depth + 1) + '\n'
      case 'strong': case 'em': case 'del': case 'link': return visible((token as Tokens.Strong).tokens, depth + 1)
      case 'code': return (token as Tokens.Code).text + '\n'
      case 'codespan': return (token as Tokens.Codespan).text
      case 'text': {
        const text = token as Tokens.Text
        return text.tokens ? visible(text.tokens, depth + 1) : entities(text.text)
      }
      case 'escape': return (token as Tokens.Escape).text
      case 'br': case 'space': case 'hr': return '\n'
      default: return ''
    }
  }).join('')
}

/** Rich editor positions are not Markdown offsets. Validate the visible quote against its fixed document. */
export function hasRequirementQuote(markdown: string, quote: string): boolean {
  if (markdown.includes(quote)) return true
  const selected = normalize(quote)
  return Boolean(selected && normalize(visible(Lexer.lex(markdown, { gfm: true }))).includes(selected))
}
