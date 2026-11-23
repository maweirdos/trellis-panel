import type {
  AgentCapabilities,
  CompleteElicitationNotification,
  MessageMcpNotification,
  MessageMcpRequest,
  RequestPermissionRequest,
} from '@agentclientprotocol/sdk/experimental/v2'

import { AGENT_METHODS, CLIENT_METHODS, PROTOCOL_VERSION } from '../t3-core/_generated/meta.gen'
import type { SessionNotification } from '../t3-core/compat'

export const ACP_V2_PROTOCOL_VERSION = PROTOCOL_VERSION
export const ACP_V2_METHODS = {
  initialize: AGENT_METHODS.initialize,
  authLogin: AGENT_METHODS.auth_login,
  authLogout: AGENT_METHODS.auth_logout,
  providersList: AGENT_METHODS.providers_list,
  providersSet: AGENT_METHODS.providers_set,
  providersDisable: AGENT_METHODS.providers_disable,
  sessionNew: AGENT_METHODS.session_new,
  sessionList: AGENT_METHODS.session_list,
  sessionDelete: AGENT_METHODS.session_delete,
  sessionFork: AGENT_METHODS.session_fork,
  sessionResume: AGENT_METHODS.session_resume,
  sessionClose: AGENT_METHODS.session_close,
  sessionSetConfigOption: AGENT_METHODS.session_set_config_option,
  sessionPrompt: AGENT_METHODS.session_prompt,
  sessionCancel: AGENT_METHODS.session_cancel,
  mcpMessage: AGENT_METHODS.mcp_message,
  clientSessionUpdate: CLIENT_METHODS.session_update,
  clientRequestPermission: CLIENT_METHODS.session_request_permission,
  clientElicitationComplete: CLIENT_METHODS.elicitation_complete,
  protocolCancelRequest: '$/cancel_request',
} as const

export type AcpVersionedInitialize = {
  readonly request: import('@agentclientprotocol/sdk/experimental/v2').InitializeRequest
  readonly response: import('@agentclientprotocol/sdk/experimental/v2').InitializeResponse
  readonly requestedVersion: 2
  readonly returnedVersion: number
  readonly capabilities: AgentCapabilities
}

export type AcpClientRequest =
  | { readonly method: typeof ACP_V2_METHODS.clientRequestPermission; readonly params: RequestPermissionRequest }
  | { readonly method: typeof ACP_V2_METHODS.mcpMessage; readonly params: MessageMcpRequest }

export type AcpClientNotification =
  | { readonly method: typeof ACP_V2_METHODS.clientSessionUpdate; readonly params: SessionNotification }
  | { readonly method: typeof ACP_V2_METHODS.clientElicitationComplete; readonly params: CompleteElicitationNotification }
  | { readonly method: typeof ACP_V2_METHODS.mcpMessage; readonly params: MessageMcpNotification }
