import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { OrchestrationV2FileChangeDetail } from '../../../../../shared/conversation/orchestrationV2'
import { checkedDirectory } from '../../../private-conversations/files'
import { workbenchPath } from '../../../project-workbench/files'
import type { ConversationDriverWorkItem } from '../registry'

type Changes = NonNullable<Extract<ConversationDriverWorkItem, { kind: 'tool' }>['fileChanges']>

export function codexFileChangeEvidence(cwd: string, input: Changes): {
  fileName: string
  changes: OrchestrationV2FileChangeDetail[]
  diffStr?: string
} | undefined {
  const changes: OrchestrationV2FileChangeDetail[] = []
  for (const change of input) {
    try {
      const absolute = resolve(cwd, change.path)
      const path = relative(cwd, absolute).replaceAll('\\', '/')
      if (!path || path !== path.trim() || path.length > 256 || isAbsolute(path) ||
        /(?:^|[/\\])\.{1,2}(?:$|[/\\])/u.test(change.path)) return
      workbenchPath(path)
      checkedDirectory(dirname(absolute))
      if (change.operation !== 'delete') {
        const entry = lstatSync(absolute)
        if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) return
      }
      changes.push({ operation: change.operation, path })
    } catch { return }
  }
  const first = changes[0]
  if (!first) return
  const diffs = input.map(change => change.diff)
  const hasAllDiffs = diffs.every(diff => diff &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(diff) && /^@@ -\d/mu.test(diff))
  const diff = !hasAllDiffs ? undefined : diffs.length === 1 ? diffs[0]
    : diffs.map((part, index) => `diff --git a/${changes[index].path} b/${changes[index].path}\n${part}`).join('\n')
  const diffStr = diff && Buffer.byteLength(diff, 'utf8') <= 4_096 ? diff : undefined
  return { fileName: first.path, changes, ...(diffStr && { diffStr }) }
}
