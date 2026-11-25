import { useMemo, type JSX } from 'react'
import { parsePatchFiles, processFile, type FileDiffMetadata } from '@pierre/diffs'
import { FileDiff, type FileDiffOptions } from '@pierre/diffs/react'
import type { ConversationProjectedWorkItem } from '../../../shared/conversation/command-runtime'
import { patchRows } from '../my/git/patch'
import { UnifiedDiff } from '../my/git/UnifiedDiff'
import { useMy } from '../my/store'
import { READABLE_DIFF_THEME } from './readableDiffTheme'

type FileChangeItem = Extract<ConversationProjectedWorkItem, { readonly type: 'file_change' }>

const DIFF_SURFACE_CSS = `
  :host { --diffs-bg: var(--my-bg-canvas); }
  [data-diffs-header="default"] {
    min-height: 2rem;
    padding-inline: 0.5rem 0.75rem;
    font-size: var(--my-text-xs);
    line-height: 1rem;
  }
  [data-diffs-header="default"] :is([data-additions-count], [data-deletions-count]) {
    font-size: var(--my-text-2xs);
  }
`

function parseTurnFileDiffs(patch: string, name: string): FileDiffMetadata[] {
  try {
    const text = patch.trimStart()
    if (!text.startsWith('@@ ')) {
      return parsePatchFiles(patch, { throwOnError: true }).flatMap(entry => entry.files)
    }
    const file = processFile(`diff --git a/file b/file\n${text}`, { throwOnError: true })
    return file?.hunks.length ? [{ ...file, name }] : []
  } catch {
    return []
  }
}

export function ConversationTurnFileChange({ item }: { readonly item: FileChangeItem }): JSX.Element {
  const theme = useMy((state) => state.theme)
  const { diffStr, fileName } = item
  const files = useMemo(() => diffStr ? parseTurnFileDiffs(diffStr, fileName) : [], [diffStr, fileName])
  const options = useMemo<FileDiffOptions<undefined, undefined>>(() => ({
    diffStyle: 'unified',
    diffIndicators: 'bars',
    theme: { light: READABLE_DIFF_THEME, dark: 'pierre-dark' },
    themeType: theme,
    preferredHighlighter: 'shiki-js',
    unsafeCSS: DIFF_SURFACE_CSS,
  }), [theme])

  if (files.length > 0) {
    return <div className="conversation-turn-file-diff" role="region" tabIndex={0} aria-label="文件差异">
      {files.map((file, index) => <FileDiff key={`${file.name}:${index}`} fileDiff={file} options={options} />)}
    </div>
  }

  const paths = item.changes?.length ? item.changes.map(change => change.path) : [fileName]
  const lines = diffStr ? patchRows(diffStr) : []
  return (
    <section className="conversation-turn-file-fallback" aria-label="更改的文件">
      <ul>{paths.map((path, index) => <li key={`${path}:${index}`}>{path}</li>)}</ul>
      {diffStr
        ? <UnifiedDiff value={{
            diff: diffStr,
            added: lines.filter(line => line.kind === 'add').length,
            removed: lines.filter(line => line.kind === 'remove').length,
            binary: false,
            truncated: false,
          }} />
        : <p className="my-item-description">此回合未保留文本差异。</p>}
    </section>
  )
}
