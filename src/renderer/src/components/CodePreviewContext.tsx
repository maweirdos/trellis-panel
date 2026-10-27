import { createContext, useContext, type ReactNode, type JSX } from 'react'

export type CodePreviewLanguage = 'html' | 'svg'
export type OpenCodePreview = (source: string, language: CodePreviewLanguage) => void
const CodePreviewContext = createContext<OpenCodePreview | null>(null)

/** A mounted conversation supplies an action, never a persisted callback. */
export function CodePreviewProvider({ openCodePreview, children }: { openCodePreview: OpenCodePreview; children: ReactNode }): JSX.Element {
  return <CodePreviewContext.Provider value={openCodePreview}>{children}</CodePreviewContext.Provider>
}

export function useOpenCodePreview(): OpenCodePreview | null { return useContext(CodePreviewContext) }
