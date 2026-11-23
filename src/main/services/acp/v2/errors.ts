export const ACP_PROTOCOL_ERROR_TYPES = [
  'E_INCOMPATIBLE',
  'E_PROTOCOL',
  'E_TIMEOUT',
  'E_DISCONNECTED',
  'E_DUPLICATE_REQUEST_ID',
  'E_MESSAGE_TOO_LARGE',
  'E_MALFORMED_FRAME',
  'E_CANCELLED',
  'E_UNSUPPORTED_CAPABILITY',
  'E_CONFLICT',
  'E_REMOTE',
  'E_CLOSED',
] as const

export type AcpProtocolErrorType = typeof ACP_PROTOCOL_ERROR_TYPES[number]

export type AcpProtocolErrorDetails = {
  readonly requestedVersion?: number
  readonly returnedVersion?: number | null
  readonly method?: string
  readonly requestId?: string | number
  readonly maxMessageBytes?: number
  readonly code?: number
  readonly cause?: unknown
}

export class AcpProtocolError extends Error {
  readonly type: AcpProtocolErrorType
  readonly details: AcpProtocolErrorDetails

  constructor(type: AcpProtocolErrorType, message: string, details: AcpProtocolErrorDetails = {}) {
    super(message)
    this.name = 'AcpProtocolError'
    this.type = type
    this.details = details
  }
}

export const incompatibleVersionError = (requestedVersion: number, returnedVersion: number): AcpProtocolError =>
  new AcpProtocolError(
    'E_INCOMPATIBLE',
    `ACP protocol is incompatible: requested ${requestedVersion}, returned ${returnedVersion}`,
    { requestedVersion, returnedVersion },
  )

export const invalidInitializeError = (returnedVersion: number | null, cause?: unknown): AcpProtocolError =>
  new AcpProtocolError(
    'E_PROTOCOL',
    'ACP v2 initialize response is invalid',
    { returnedVersion, cause },
  )

export const remoteError = (method: string, code: number, message: string, data?: unknown): AcpProtocolError =>
  new AcpProtocolError('E_REMOTE', message, { method, cause: { code, message, data } })
