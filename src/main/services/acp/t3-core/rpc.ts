import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import * as AcpSchema from "./_generated/schema.gen.ts";
import { AGENT_METHODS, CLIENT_METHODS } from "./_generated/meta.gen.ts";

const InitializeRpc = Rpc.make(AGENT_METHODS.initialize, {
  payload: AcpSchema.InitializeRequest,
  success: Schema.Union([AcpSchema.InitializeResponse, Schema.Struct({ protocolVersion: Schema.Number })]),
  error: AcpSchema.Error,
});

const LoginRpc = Rpc.make(AGENT_METHODS.auth_login, {
  payload: AcpSchema.LoginAuthRequest,
  success: AcpSchema.LoginAuthResponse,
  error: AcpSchema.Error,
});

const LogoutRpc = Rpc.make(AGENT_METHODS.auth_logout, {
  payload: AcpSchema.LogoutAuthRequest,
  success: AcpSchema.LogoutAuthResponse,
  error: AcpSchema.Error,
});

const NewSessionRpc = Rpc.make(AGENT_METHODS.session_new, {
  payload: AcpSchema.NewSessionRequest,
  success: AcpSchema.NewSessionResponse,
  error: AcpSchema.Error,
});

const ListSessionsRpc = Rpc.make(AGENT_METHODS.session_list, {
  payload: AcpSchema.ListSessionsRequest,
  success: AcpSchema.ListSessionsResponse,
  error: AcpSchema.Error,
});

const ForkSessionRpc = Rpc.make(AGENT_METHODS.session_fork, {
  payload: AcpSchema.ForkSessionRequest,
  success: AcpSchema.ForkSessionResponse,
  error: AcpSchema.Error,
});

const ResumeSessionRpc = Rpc.make(AGENT_METHODS.session_resume, {
  payload: AcpSchema.ResumeSessionRequest,
  success: AcpSchema.ResumeSessionResponse,
  error: AcpSchema.Error,
});

const CloseSessionRpc = Rpc.make(AGENT_METHODS.session_close, {
  payload: AcpSchema.CloseSessionRequest,
  success: AcpSchema.CloseSessionResponse,
  error: AcpSchema.Error,
});

const DeleteSessionRpc = Rpc.make(AGENT_METHODS.session_delete, {
  payload: AcpSchema.DeleteSessionRequest,
  success: AcpSchema.DeleteSessionResponse,
  error: AcpSchema.Error,
});

const ListProvidersRpc = Rpc.make(AGENT_METHODS.providers_list, {
  payload: AcpSchema.ListProvidersRequest,
  success: AcpSchema.ListProvidersResponse,
  error: AcpSchema.Error,
});

const SetProviderRpc = Rpc.make(AGENT_METHODS.providers_set, {
  payload: AcpSchema.SetProviderRequest,
  success: AcpSchema.SetProviderResponse,
  error: AcpSchema.Error,
});

const DisableProviderRpc = Rpc.make(AGENT_METHODS.providers_disable, {
  payload: AcpSchema.DisableProviderRequest,
  success: AcpSchema.DisableProviderResponse,
  error: AcpSchema.Error,
});

const PromptRpc = Rpc.make(AGENT_METHODS.session_prompt, {
  payload: AcpSchema.PromptRequest,
  success: AcpSchema.PromptResponse,
  error: AcpSchema.Error,
});

const SetSessionConfigOptionRpc = Rpc.make(AGENT_METHODS.session_set_config_option, {
  payload: AcpSchema.SetSessionConfigOptionRequest,
  success: AcpSchema.SetSessionConfigOptionResponse,
  error: AcpSchema.Error,
});

const RequestPermissionRpc = Rpc.make(CLIENT_METHODS.session_request_permission, {
  payload: AcpSchema.RequestPermissionRequest,
  success: AcpSchema.RequestPermissionResponse,
  error: AcpSchema.Error,
});

const ElicitationRpc = Rpc.make(CLIENT_METHODS.elicitation_create, {
  payload: AcpSchema.CreateElicitationRequest,
  success: AcpSchema.CreateElicitationResponse,
  error: AcpSchema.Error,
});

export const AgentRpcs = RpcGroup.make(
  InitializeRpc,
  LoginRpc,
  LogoutRpc,
  NewSessionRpc,
  ListSessionsRpc,
  ForkSessionRpc,
  ResumeSessionRpc,
  CloseSessionRpc,
  DeleteSessionRpc,
  ListProvidersRpc,
  SetProviderRpc,
  DisableProviderRpc,
  PromptRpc,
  SetSessionConfigOptionRpc,
);

const ConnectMcpRpc = Rpc.make(CLIENT_METHODS.mcp_connect, {
  payload: AcpSchema.ConnectMcpRequest,
  success: AcpSchema.ConnectMcpResponse,
  error: AcpSchema.Error,
});

const MessageMcpRpc = Rpc.make(CLIENT_METHODS.mcp_message, {
  payload: AcpSchema.MessageMcpRequest,
  success: AcpSchema.MessageMcpResponse,
  error: AcpSchema.Error,
});

const DisconnectMcpRpc = Rpc.make(CLIENT_METHODS.mcp_disconnect, {
  payload: AcpSchema.DisconnectMcpRequest,
  success: AcpSchema.DisconnectMcpResponse,
  error: AcpSchema.Error,
});

export const ClientRpcs = RpcGroup.make(
  RequestPermissionRpc,
  ElicitationRpc,
  ConnectMcpRpc,
  MessageMcpRpc,
  DisconnectMcpRpc,
);
