import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sha256Hex } from './operations'

/**
 * 最小 PRD 来源草稿（design §7.2）：
 * - 含 issue 标识/URL/updatedAtMs/fetchedAtMs + 完整规范化描述 + “待结合本机代码确认”标注；
 * - 描述是业务数据：放在加长围栏代码块里原文呈现（不解释为指令/不执行）；
 * - 富文本不做臆测转换：保留原文 + 原来源链接；无法转换的部分注明；
 * - 描述缺失（权限/缺字段）或超限额截断时显式标注，不静默摘要替代；
 * - 文件用同目录临时文件原子替换；已有用户修改不覆盖（判定在上层，用 prdChangedSinceBaseline）。
 */

/** 描述字节限额（超出显式截断标注；不静默摘要替代）。 */
export const PRD_DESCRIPTION_LIMIT_BYTES = 256 * 1024

export interface SourcePrdInput {
  issueKey: string
  issueId: number | null
  instanceId: string
  url: string
  updatedAtMs: number | null
  fetchedAtMs: number
  title: string
  summaryDescription: string
  description: string | null
}

function iso(ms: number | null): string {
  return ms === null ? '未知' : new Date(ms).toISOString()
}

/** 计算能包住正文的最长反引号围栏（正文含 ``` 时自动加长）。 */
export function fenceFor(text: string): string {
  let maxRun = 0
  let run = 0
  for (const ch of text) {
    if (ch === '`') {
      run += 1
      if (run > maxRun) maxRun = run
    } else {
      run = 0
    }
  }
  return '`'.repeat(Math.max(3, maxRun + 1))
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf-8')
}

export function renderSourcePrd(input: SourcePrdInput): { content: string; truncated: boolean } {
  const lines: string[] = []
  lines.push(`# [${input.issueKey}] ${input.title.replace(/^\[[^\]]*\]\s*/, '')}`)
  lines.push('')
  lines.push('> 来源：Jira 工单导入草稿（待结合本机代码确认）。本文件由面板生成，业务描述按原文呈现。')
  lines.push('')
  lines.push('## 工单来源')
  lines.push('')
  lines.push(`- Issue：\`${input.issueKey}\`${input.issueId !== null ? `（数字 ID \`${input.issueId}\`）` : ''}`)
  if (input.url !== '') lines.push(`- 原始链接：${input.url}`)
  lines.push(`- Jira 更新时间：${iso(input.updatedAtMs)}${input.updatedAtMs !== null ? `（Unix 毫秒 \`${input.updatedAtMs}\`）` : ''}`)
  lines.push(`- 面板采集时间：${iso(input.fetchedAtMs)}（Unix 毫秒 \`${input.fetchedAtMs}\`）`)
  lines.push(`- 摘要：${input.summaryDescription.trim() !== '' ? input.summaryDescription.trim().split(/\r?\n/)[0] : input.title}`)
  lines.push('')
  lines.push('## Jira 描述（原文呈现）')
  lines.push('')
  if (input.description === null) {
    lines.push('（描述未取得——可能受接口字段权限限制或该字段为空。请打开原工单链接核对，勿凭摘要替代完整输入。）')
  } else if (input.description.trim() === '') {
    lines.push('（工单描述为空。）')
  } else {
    const bytes = utf8Bytes(input.description)
    let body = input.description
    let truncated = false
    if (bytes > PRD_DESCRIPTION_LIMIT_BYTES) {
      // 按字节截断；多字节边界产生的替代符从尾部去掉（不撕裂可见内容）
      body = Buffer.from(input.description, 'utf-8').subarray(0, PRD_DESCRIPTION_LIMIT_BYTES).toString('utf-8').replace(/\uFFFD+$/, '')
      truncated = true
    }
    const fence = fenceFor(body)
    lines.push(fence + 'text')
    lines.push(body)
    lines.push(fence)
    if (truncated) {
      lines.push('')
      lines.push(`> 注意：描述超过 ${PRD_DESCRIPTION_LIMIT_BYTES} 字节限额，此处为截断样本（原文 ${bytes} 字节）。完整内容请打开原工单链接查看。`)
    }
    lines.push('')
    lines.push('（Jira 富文本按原文保留；未能安全转换的格式请以上方原始链接为准。）')
  }
  lines.push('')
  lines.push('## 待办')
  lines.push('')
  lines.push('- [ ] 待结合本机代码确认需求与技术方案')
  lines.push('- [ ] 补充验收标准（本草稿不含技术分析结论）')
  lines.push('')
  return { content: lines.join('\n'), truncated: input.description !== null && utf8Bytes(input.description) > PRD_DESCRIPTION_LIMIT_BYTES }
}

/** 同目录临时文件原子替换（design §7.2：文件用同目录临时文件原子替换）。 */
export function atomicWriteText(absPath: string, content: string): void {
  mkdirSync(dirname(absPath), { recursive: true })
  const tmp = join(dirname(absPath), `.${basenameOf(absPath)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, absPath)
}

function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

/** 读取文件并返回内容与 sha256（缺失返回 null）。 */
export function readFileHash(absPath: string): { content: string; sha256: string } | null {
  try {
    const content = readFileSync(absPath, 'utf-8')
    return { content, sha256: sha256Hex(content) }
  } catch {
    return null
  }
}
