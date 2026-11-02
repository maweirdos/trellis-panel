import { createContext, useContext, type ReactNode, type JSX } from 'react'
import type { AcpImageAttachment } from '../../../shared/acp-images'

/** File operations belong to the displayed conversation, independently of the shell project. */
export interface DocumentSourceClient {
  isCurrent(): boolean
  openDocument(path: string): Promise<void>
  readImage(imageId: string): Promise<AcpImageAttachment>
  saveImage(imageId: string): Promise<void>
}

const DocumentSource = createContext<DocumentSourceClient | null>(null)

export function DocumentSourceProvider({ client, children }: { client: DocumentSourceClient | null; children: ReactNode }): JSX.Element {
  return <DocumentSource.Provider value={client}>{children}</DocumentSource.Provider>
}

export function useDocumentSource(): DocumentSourceClient | null {
  return useContext(DocumentSource)
}
