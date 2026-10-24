import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TaskConversationSource } from '../../../../shared/task-conversations'
import type { LaunchPorts, NativeReader, NativeReadResult, TaskConversationsOptions, NativeHistoryFile } from '../types'
import { readCodex } from './codex'
import { readClaude } from './claude'
import { readZcode } from './zcode'
import { resolveZcodeRoot } from './zcode-root'
import { MAX_ITEMS } from './paths'
import { applyCapability } from './launch'
import { NativeHistoryScanner } from './history'

export const SOURCES: TaskConversationSource[] = ['codex', 'claude-code', 'zcode']
export function nativeReader(options: TaskConversationsOptions, launch: LaunchPorts): NativeReader {
  const roots = {
    codex: options.nativeRoots?.codex ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    'claude-code': options.nativeRoots?.['claude-code'] ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  }
  const history = new NativeHistoryScanner()
  return async (root, requested = []): Promise<NativeReadResult> => {
    const results = await Promise.allSettled(SOURCES.map(async source => {
      const capability = await launch.capability(source)
      const histories: NativeHistoryFile[] = []
      const read = source === 'codex' ? { items: readCodex(roots[source], root, requested, histories), truncated: false }
        : source === 'zcode' ? { items: readZcode(resolveZcodeRoot(options.nativeRoots?.zcode), root, requested, histories), truncated: false }
          : readClaude(roots[source], root, requested, histories)
      return { source, items: read.items.map(item => applyCapability(item, capability)), truncated: read.truncated || read.items.length > MAX_ITEMS,
        histories,
        status: { source, available: true, detail: read.items.length === 0 && !read.truncated ? '当前项目没有可验证的原生会话' : capability.detail || (capability.available ? undefined : '原生打开能力不可用') } }
    }))
    const result: NativeReadResult = { items: [], sources: [], truncated: false }
    const histories: NativeHistoryFile[] = []
    results.forEach((entry, index) => {
      const source = SOURCES[index]
      if (entry.status === 'fulfilled') {
        result.items.push(...entry.value.items.slice(0, MAX_ITEMS), ...entry.value.items.slice(MAX_ITEMS).filter(item => requested.some(wanted => wanted.source === source && wanted.sessionId === item.sessionId)))
        result.sources.push(entry.value.status)
        result.truncated ||= entry.value.truncated
        histories.push(...entry.value.histories.filter(file => result.items.some(item => item.id === file.conversation.id)))
      } else {
        const locked = /busy|locked/i.test(String(entry.reason))
        const unsupported = /schema/i.test(String(entry.reason))
        result.sources.push({ source, available: false, detail: locked ? '原生元信息库暂时被占用，请重试' : unsupported ? '原生元信息 schema 不受支持' : '原生元信息不可读取或尚未安装' })
      }
    })
    const scanned = await history.scan(root, histories)
    result.indexing = scanned.indexing
    result.evidence = scanned.evidence
    result.runtimeAliases = scanned.runtimeAliases
    result.historyProgress = scanned.progress
    result.historyFiles = histories
    for (const source of result.sources) if (scanned.limited.has(source.source)) source.detail = [source.detail, '部分原生历史不可读取、格式不支持或超过扫描上限，自动关联可能不完整'].filter(Boolean).join('；')
    return result
  }
}
