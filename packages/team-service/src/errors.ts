export class TeamServiceError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); this.name = 'TeamServiceError' }
}
export function requireValue<T>(value: T | null | undefined, code: string, message: string, statusCode = 404): T {
  if (value === null || value === undefined) throw new TeamServiceError(code, message, statusCode)
  return value
}
