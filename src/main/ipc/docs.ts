/** Legacy document entry now shares the main-owned versioned view registry. */
import { registerDocumentViewIpc } from './document-views'
import type { WindowDeps } from './deps'

export function registerDocsIpc(deps: WindowDeps): void { registerDocumentViewIpc(deps) }
