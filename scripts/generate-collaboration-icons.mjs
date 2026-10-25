import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

const source = readFileSync(resolve('src/shared/collaboration-icons.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { COLLABORATION_GLYPHS: glyphs, COLLABORATION_ICON_COLORS: colors } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const check = process.argv.includes('--check')
const output = resolve('resources/collaboration')
const names = { overview: '协作概览', spaces: '空间', members: '同事', agents: 'Agent', crews: '小队', skills: '技能', tasks: '任务', board: '看板', inbox: '收件箱', triage: '分拣', projects: '专项', iterations: '版本', automations: '自动化', review: '评审', done: '完成', blocked: '受阻', backlog: '待规划', todo: '待开始', in_progress: '进行中', cancelled: '取消', relation: '关联', comment: '讨论', activity: '动态', reports: '报告' }
const save = (relative, contents) => {
  const file = resolve(output, relative)
  if (check) assert.equal(existsSync(file) ? readFileSync(file, 'utf8') : '', contents, `Generated icon drift: ${relative}`)
  else { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, contents) }
}
const symbols = (theme) => Object.entries(glyphs).map(([name, glyph]) => `<symbol id="${name}" viewBox="0 0 24 24"><path d="${glyph.fill}" fill="${colors[glyph.tone][theme]}" opacity=".14"/><path d="${glyph.path}" fill="none" stroke="${colors[glyph.tone][theme]}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>`).join('\n')
for (const theme of ['light', 'dark']) {
  const tokenSource = readFileSync(resolve('src/renderer/src/my/my-tokens.css'), 'utf8')
  for (const [tone, color] of Object.entries(colors)) assert.ok(tokenSource.includes(`--my-collab-${tone}: ${color[theme]};`), 'UI and exported SVG use the same palette')
  for (const [name, glyph] of Object.entries(glyphs)) save(`${theme}/${name}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" role="img" aria-label="${names[name]}"><path d="${glyph.fill}" fill="${colors[glyph.tone][theme]}" opacity=".14"/><path d="${glyph.path}" fill="none" stroke="${colors[glyph.tone][theme]}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`)
  save(`${theme}/sprite.svg`, `<svg xmlns="http://www.w3.org/2000/svg">\n${symbols(theme)}\n</svg>\n`)
}
save('index.html', `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>团队协作图标</title><style>*{box-sizing:border-box}body{margin:0;background:#f6f6f4;color:#282b30;font:14px/1.5 'Segoe UI','Microsoft YaHei',sans-serif}header{padding:40px 40px 24px}h1{font-size:26px;letter-spacing:-.02em;margin:0 0 8px}p{margin:0;color:#737373}.sheets{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:0 40px 40px}.sheet{padding:24px;border-radius:12px;background:#fff}.sheet.dark{background:#181818;color:#ececec}h2{font-size:14px;font-weight:600;margin:0 0 24px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:28px 12px}.icon{display:flex;flex-direction:column;align-items:center;gap:9px}.sizes{height:32px;display:flex;gap:8px;align-items:center}.label{font-size:12px}.id{font:10px monospace;opacity:.6}@media(max-width:800px){.sheets{grid-template-columns:1fr;padding:0 16px 24px}header{padding:24px 16px}.grid{gap:22px 6px}}</style><header><h1>团队协作图标</h1><p>24 枚双色 SVG · 统一 24 × 24 网格与 1.6 描边 · 16 / 20 / 24 像素适配 · 浅色与深色</p></header><div class="sheets">${['light', 'dark'].map((theme) => `<section class="sheet ${theme}"><h2>${theme === 'light' ? '浅色界面' : '深色界面'}</h2><div class="grid">${Object.keys(glyphs).map((name) => `<div class="icon"><div class="sizes">${[16, 20, 24].map((size) => `<img src="${theme}/${name}.svg" width="${size}" height="${size}" alt="">`).join('')}</div><span class="label">${names[name]}</span><span class="id">${name}</span></div>`).join('')}</div></section>`).join('')}</div></html>\n`)
console.log(`${check ? 'Verified' : 'Generated'} ${Object.keys(glyphs).length} collaboration icons in light/dark themes, sprites and gallery`)
