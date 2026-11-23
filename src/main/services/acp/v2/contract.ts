import { z } from 'zod'

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk/experimental/v2'
import {
  zCancelSessionNotification,
  zCloseSessionRequest,
  zCloseSessionResponse,
  zCompleteElicitationNotification,
  zDeleteSessionRequest,
  zDeleteSessionResponse,
  zDisableProviderRequest,
  zDisableProviderResponse,
  zForkSessionRequest,
  zForkSessionResponse,
  zListProvidersRequest,
  zListProvidersResponse,
  zListSessionsRequest,
  zListSessionsResponse,
  zLoginAuthRequest,
  zLoginAuthResponse,
  zLogoutAuthRequest,
  zLogoutAuthResponse,
  zMessageMcpNotification,
  zMessageMcpRequest,
  zMessageMcpResponse,
  zNewSessionRequest,
  zNewSessionResponse,
  zPromptRequest,
  zPromptResponse,
  zRequestPermissionRequest,
  zRequestPermissionResponse,
  zResumeSessionRequest,
  zResumeSessionResponse,
  zSetProviderRequest,
  zSetProviderResponse,
  zSetSessionConfigOptionRequest,
  zSetSessionConfigOptionResponse,
  zUpdateSessionNotification,
} from './generated/zod.gen.js'
import type {
  AgentCapabilities,
  CancelSessionNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  CompleteElicitationNotification,
  DisableProviderRequest,
  DisableProviderResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListProvidersRequest,
  ListProvidersResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoginAuthRequest,
  LoginAuthResponse,
  LogoutAuthRequest,
  LogoutAuthResponse,
  MessageMcpNotification,
  MessageMcpRequest,
  MessageMcpResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionId,
  SetProviderRequest,
  SetProviderResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  UpdateSessionNotification,
} from '@agentclientprotocol/sdk/experimental/v2'

export const ACP_V2_PROTOCOL_VERSION = PROTOCOL_VERSION
export const ACP_V2_METHODS = {
  initialize: 'initialize',
  authLogin: 'auth/login',
  authLogout: 'auth/logout',
  providersList: 'providers/list',
  providersSet: 'providers/set',
  providersDisable: 'providers/disable',
  sessionNew: 'session/new',
  sessionList: 'session/list',
  sessionDelete: 'session/delete',
  sessionFork: 'session/fork',
  sessionResume: 'session/resume',
  sessionClose: 'session/close',
  sessionSetConfigOption: 'session/set_config_option',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  mcpMessage: 'mcp/message',
  clientSessionUpdate: 'session/update',
  clientRequestPermission: 'session/request_permission',
  clientElicitationComplete: 'elicitation/complete',
  protocolCancelRequest: '$/cancel_request',
} as const

export const ACP_PROTOCOL_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const

const sessionIdSchema = z.string().min(1)
const metaSchema = z.record(z.string(), z.unknown())
const jsonRpcIdSchema = z.union([z.string().min(1), z.number().int()])

const negotiatedCapabilitiesSchema = z.object({
  session: z.object({}).passthrough(),
  _meta: metaSchema.optional(),
}).passthrough()

export const initializeResultSchema = z.object({
  protocolVersion: z.number().int(),
  info: z.object({
    name: z.string().min(1),
    title: z.string().optional().nullable(),
    version: z.string().min(1),
    _meta: metaSchema.optional(),
  }),
  capabilities: negotiatedCapabilitiesSchema,
  authMethods: z.array(z.object({}).passthrough()).optional(),
  _meta: metaSchema.optional(),
}).passthrough()

export const operationSchemas = {
  [ACP_V2_METHODS.authLogin]: { params: zLoginAuthRequest, result: zLoginAuthResponse },
  [ACP_V2_METHODS.authLogout]: { params: zLogoutAuthRequest, result: zLogoutAuthResponse },
  [ACP_V2_METHODS.providersList]: { params: zListProvidersRequest, result: zListProvidersResponse },
  [ACP_V2_METHODS.providersSet]: { params: zSetProviderRequest, result: zSetProviderResponse },
  [ACP_V2_METHODS.providersDisable]: { params: zDisableProviderRequest, result: zDisableProviderResponse },
  [ACP_V2_METHODS.sessionNew]: { params: zNewSessionRequest, result: zNewSessionResponse },
  [ACP_V2_METHODS.sessionList]: { params: zListSessionsRequest, result: zListSessionsResponse },
  [ACP_V2_METHODS.sessionDelete]: { params: zDeleteSessionRequest, result: zDeleteSessionResponse },
  [ACP_V2_METHODS.sessionFork]: { params: zForkSessionRequest, result: zForkSessionResponse },
  [ACP_V2_METHODS.sessionResume]: { params: zResumeSessionRequest, result: zResumeSessionResponse },
  [ACP_V2_METHODS.sessionClose]: { params: zCloseSessionRequest, result: zCloseSessionResponse },
  [ACP_V2_METHODS.sessionSetConfigOption]: { params: zSetSessionConfigOptionRequest, result: zSetSessionConfigOptionResponse },
  [ACP_V2_METHODS.sessionPrompt]: { params: zPromptRequest, result: zPromptResponse },
  [ACP_V2_METHODS.mcpMessage]: { params: zMessageMcpRequest, result: zMessageMcpResponse },
} as const

export const cancelSessionSchema = zCancelSessionNotification
export const clientRequestSchemas = {
  [ACP_V2_METHODS.clientRequestPermission]: { params: zRequestPermissionRequest, result: zRequestPermissionResponse },
  [ACP_V2_METHODS.mcpMessage]: { params: zMessageMcpRequest, result: zMessageMcpResponse },
} as const
export const clientNotificationSchemas = {
  [ACP_V2_METHODS.clientSessionUpdate]: zUpdateSessionNotification,
  [ACP_V2_METHODS.clientElicitationComplete]: zCompleteElicitationNotification,
  [ACP_V2_METHODS.mcpMessage]: zMessageMcpNotification,
} as const

export type AcpInitializeResult = z.infer<typeof initializeResultSchema>
export type AcpNegotiatedCapabilities = AcpInitializeResult['capabilities']
export type AcpSessionUpdateNotification = UpdateSessionNotification
export type AcpRequestPermissionRequest = RequestPermissionRequest
export type AcpRequestPermissionResponse = RequestPermissionResponse
export type AcpCompleteElicitationNotification = CompleteElicitationNotification

export type AcpClientRequest =
  | { readonly method: typeof ACP_V2_METHODS.clientRequestPermission; readonly params: RequestPermissionRequest }
  | { readonly method: typeof ACP_V2_METHODS.mcpMessage; readonly params: MessageMcpRequest }

export type AcpClientNotification =
  | { readonly method: typeof ACP_V2_METHODS.clientSessionUpdate; readonly params: UpdateSessionNotification }
  | { readonly method: typeof ACP_V2_METHODS.clientElicitationComplete; readonly params: CompleteElicitationNotification }
  | { readonly method: typeof ACP_V2_METHODS.mcpMessage; readonly params: MessageMcpNotification }

export type AcpWireMessage =
  | { readonly jsonrpc: '2.0'; readonly id: string | number; readonly method: string; readonly params?: unknown }
  | { readonly jsonrpc: '2.0'; readonly method: string; readonly params?: unknown }
  | { readonly jsonrpc: '2.0'; readonly id: string | number; readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown } }

export type AcpVersionedInitialize = {
  readonly request: InitializeRequest
  readonly response: InitializeResponse
  readonly requestedVersion: 2
  readonly returnedVersion: number
  readonly capabilities: AgentCapabilities
}

export const sessionCancelParamsSchema = z.object({
  sessionId: sessionIdSchema,
  _meta: metaSchema.optional(),
}).passthrough()

export const cancelRequestParamsSchema = z.object({
  id: jsonRpcIdSchema,
})

export type CancelSessionParams = z.infer<typeof sessionCancelParamsSchema>
export type CancelRequestParams = z.infer<typeof cancelRequestParamsSchema>
export type { CancelSessionNotification }
