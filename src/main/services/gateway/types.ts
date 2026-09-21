export interface ContextHit {
  id: string
  title: string
  source: string
  sourceLabel: string
  path?: string
  snippet: string
  score: number
  metadata?: Record<string, unknown>
}

export interface McpContextProvider {
  id: string
  name: string
  description: string
  isRemote: boolean
  isEnabled: (root: string) => boolean
  search: (query: string, limit: number, root: string) => Promise<ContextHit[]>
  testConnection: (root?: string) => Promise<{ ok: boolean; error?: string; details?: Record<string, unknown> }>
  getItemCount?: (root: string) => Promise<number>
}

export interface GatewayToolDef {
  name: string
  description: string
  upstreamId: string
  parameters: Record<string, { type: string; description: string; required?: boolean; default?: unknown }>
  isReadOnly: boolean
  securityRule?: string
}

export interface GatewayUpstream {
  id: string
  name: string
  category: 'database' | 'knowledge' | 'project' | 'custom'
  description: string
  status: 'connected' | 'disconnected' | 'error' | 'disabled'
  endpoint?: string
  tools: GatewayToolDef[]
  isRemote: boolean
  enabled: boolean
  error?: string
  lastChecked?: number
  config?: Record<string, unknown>
}

export interface GatewaySecurityConfig {
  sqlReadOnly: boolean
  timeoutMs: number
  maxResponseChars: number
}

export interface GatewayLogEntry {
  id: string
  timestamp: number
  toolName: string
  upstreamId: string
  input?: Record<string, unknown>
  status: 'success' | 'blocked' | 'error'
  elapsedMs: number
  responsePreview?: string
  error?: string
  query?: string
  hitsCount?: number
  sources?: Array<{ source: string; label: string; count: number }>
}

export interface GatewayProviderSummary {
  id: string
  name: string
  description: string
  isRemote: boolean
  enabled: boolean
  status: 'connected' | 'disconnected' | 'error' | 'disabled'
  itemCount?: number
  lastChecked?: number
  error?: string
}

export interface GatewayStatus {
  ok: boolean
  running: boolean
  transport: 'stdio' | 'sse' | 'http'
  upstreams: GatewayUpstream[]
  tools: GatewayToolDef[]
  security: GatewaySecurityConfig
  totalQueries: number
  recentLogs: GatewayLogEntry[]
  providers?: GatewayProviderSummary[]
}

export interface GatewayTestToolResult {
  ok: boolean
  elapsedMs: number
  result?: unknown
  error?: string
  blockedBySecurity?: boolean
}
