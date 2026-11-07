export function requirementOutline(body: string, original: string): { title: string; criteria: string[] } {
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? original.trim().split('\n')[0] ?? '需求草稿'
  const header = body.match(/^(#{1,3})\s*(?:[一二三四五六七八九十百\d]+[.、\s]*)?(?:验收(?:标准|条件|要点|清单|准则|用例)|功能验收|Acceptance(?: criteria| checks)?)\s*$/im)
  const remaining = header ? body.slice((header.index ?? 0) + header[0].length) : ''
  const boundary = header ? remaining.search(new RegExp(`^#{1,${header[1]?.length ?? 1}}\\s`, 'm')) : -1
  const section = boundary >= 0 ? remaining.slice(0, boundary) : remaining
  const lines = section.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '').split('\n'), criteria: string[] = []
  let paragraphOpen = false, group = ''
  const add = (text: string): void => { if (text.trim()) criteria.push(group ? `${group}：${text}` : text) }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim() ?? ''
    if (!line) { paragraphOpen = false; continue }
    const subheading = line.match(/^#{2,6}\s+(.+)/)
    if (subheading) { group = subheading[1]?.trim() ?? ''; paragraphOpen = false; continue }
    const cells = tableCells(line), separator = lines[index + 1]?.trim()
    if (cells.length > 1 && separator && tableCells(separator).every(cell => /^:?-{3,}:?$/.test(cell))) {
      const headings = cells.map(cell => cell.replace(/[*`_]/g, '').trim().toLowerCase())
      const given = headings.findIndex(cell => /^(given|给定|前提|前置条件)/.test(cell))
      const when = headings.findIndex(cell => /^(when|当|操作|执行步骤)/.test(cell))
      const then = headings.findIndex(cell => /^(then|则|预期|期望)/.test(cell))
      index += 2
      for (; index < lines.length && lines[index]?.includes('|'); index++) {
        const row = tableCells(lines[index] ?? '')
        if (row.every(cell => !cell)) continue
        if (given >= 0 && when >= 0 && then >= 0) {
          if (row[given]?.trim() && row[when]?.trim() && row[then]?.trim()) add(`Given ${row[given]} When ${row[when]} Then ${row[then]}`)
        } else add(row.filter(Boolean).join(' · '))
      }
      index--
      paragraphOpen = false
      continue
    }
    if (cells.length > 1) throw Error('验收表格式不完整，请核对表头和分隔行。')
    if (/^(?:[-*]|\d+[.)、])\s/.test(line)) { add(line.replace(/^(?:[-*]|\d+[.)、])\s*(?:\[[ xX]\]\s*)?/, '').trim()); paragraphOpen = true }
    else if (!line.startsWith('#')) {
      if (paragraphOpen && criteria.length) criteria[criteria.length - 1] += ' ' + line
      else add(line)
      paragraphOpen = true
    }
  }
  return { title: title.replace(/[*`]/g, '').slice(0, 200), criteria }
}

function tableCells(line: string): string[] {
  const cells: string[] = [], text = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  let cell = '', escaped = false
  for (const character of text) {
    if (character === '|' && !escaped) { cells.push(cell.trim()); cell = ''; continue }
    if (escaped && character === '|') { cell = cell.slice(0, -1) + '|'; escaped = false; continue }
    cell += character; escaped = character === '\\' && !escaped
  }
  cells.push(cell.trim())
  return cells
}

export function discussionInput(original: string, files: { name: string; text: string }[], candidate: string, answer: string): string {
  return [
    '## 客户原始诉求', original,
    ...files.flatMap(file => [`## 明确附加的资料：${file.name}`, file.text]),
    ...(candidate ? ['## 上一轮候选（未经批准，供本轮修改）', candidate] : []),
    ...(answer.trim() ? ['## 产品本轮补充或回答', answer.trim()] : [])
  ].join('\n\n')
}

export async function bodyDigest(body: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
