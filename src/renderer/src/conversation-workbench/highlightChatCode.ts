import { getSharedHighlighter, type SupportedLanguages } from '@pierre/diffs'
import { READABLE_DIFF_THEME } from './readableDiffTheme'

export async function highlightChatCode(code: string, language: string, appearance: 'light' | 'dark') {
  const theme = appearance === 'light' ? READABLE_DIFF_THEME : 'pierre-dark'
  const lang = language.toLowerCase() as SupportedLanguages
  const highlighter = await getSharedHighlighter({
    themes: [READABLE_DIFF_THEME, 'pierre-dark'],
    langs: [lang],
    preferredHighlighter: 'shiki-js',
  })
  const { tokens } = highlighter.codeToTokens(code, { lang, theme })
  const rendered = tokens.map(line => line.map(token => token.content).join('')).join('\n')
  return rendered === code ? tokens : undefined
}
