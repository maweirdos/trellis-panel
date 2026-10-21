/** Additive, clean-room schema. Legacy control tables retain their own version. */
export const WORKFLOW_CONTROL_SCHEMA_VERSION = 1

export const WORKFLOW_CONTROL_DDL = `
CREATE TABLE IF NOT EXISTS workflow_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_owners (
  workspaceKey TEXT PRIMARY KEY, scopeKey TEXT NOT NULL, scopeJson TEXT NOT NULL,
  ownerId TEXT NOT NULL, pid INTEGER NOT NULL, fencingToken INTEGER NOT NULL,
  leaseUntil INTEGER NOT NULL, state TEXT NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  scopeKey TEXT NOT NULL, runId TEXT NOT NULL, revision INTEGER NOT NULL,
  runJson TEXT NOT NULL, manifestJson TEXT, updatedAt INTEGER NOT NULL,
  PRIMARY KEY(scopeKey,runId,revision)
);
CREATE TABLE IF NOT EXISTS workflow_heads (
  scopeKey TEXT PRIMARY KEY, runId TEXT NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_commands (
  scopeKey TEXT NOT NULL, commandId TEXT NOT NULL, requestHash TEXT NOT NULL,
  commandJson TEXT NOT NULL, commitHash TEXT, status TEXT NOT NULL, ownerId TEXT NOT NULL,
  fencingToken INTEGER NOT NULL, acknowledgedSequence INTEGER NOT NULL,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  PRIMARY KEY(scopeKey,commandId)
);
CREATE TABLE IF NOT EXISTS workflow_revision_reservations (
  scopeKey TEXT NOT NULL, targetKey TEXT NOT NULL, commandId TEXT NOT NULL,
  PRIMARY KEY(scopeKey,targetKey)
);
CREATE TABLE IF NOT EXISTS workflow_revisions (
  scopeKey TEXT NOT NULL, predecessorRunId TEXT NOT NULL, predecessorRevision INTEGER NOT NULL,
  successorRunId TEXT NOT NULL, successorRevision INTEGER NOT NULL, commandId TEXT NOT NULL,
  PRIMARY KEY(scopeKey,predecessorRunId,predecessorRevision)
);
CREATE TABLE IF NOT EXISTS workflow_run_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, eventId TEXT NOT NULL UNIQUE,
  scopeKey TEXT, runId TEXT, revision INTEGER, payloadDigest TEXT NOT NULL,
  eventJson TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_events_scope ON workflow_run_events(scopeKey,sequence);
CREATE INDEX IF NOT EXISTS workflow_events_run ON workflow_run_events(scopeKey,runId,revision,sequence);
CREATE TABLE IF NOT EXISTS workflow_dispatch_outbox (
  scopeKey TEXT NOT NULL, operationId TEXT NOT NULL, commandId TEXT NOT NULL,
  operationJson TEXT NOT NULL, state TEXT NOT NULL, ownerId TEXT,
  fencingToken INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  dispatchedAt INTEGER, evidenceJson TEXT NOT NULL DEFAULT '[]', updatedAt INTEGER NOT NULL,
  PRIMARY KEY(scopeKey,operationId)
);
CREATE INDEX IF NOT EXISTS workflow_outbox_pending ON workflow_dispatch_outbox(scopeKey,state,operationId);
CREATE TABLE IF NOT EXISTS workflow_dispatch_attempts (
  scopeKey TEXT NOT NULL, operationId TEXT NOT NULL, attempt INTEGER NOT NULL,
  ownerId TEXT NOT NULL, fencingToken INTEGER NOT NULL,
  dispatchedAt INTEGER NOT NULL, state TEXT NOT NULL, resultJson TEXT,
  PRIMARY KEY(scopeKey,operationId,attempt)
);
CREATE TABLE IF NOT EXISTS workflow_sync_outbox (
  deliveryId TEXT PRIMARY KEY, scopeKey TEXT NOT NULL, eventId TEXT NOT NULL,
  sequence INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', confirmedAt INTEGER
);
CREATE INDEX IF NOT EXISTS workflow_sync_pending ON workflow_sync_outbox(scopeKey,state,sequence);
CREATE TABLE IF NOT EXISTS workflow_steps (
  scopeKey TEXT NOT NULL, runId TEXT NOT NULL, revision INTEGER NOT NULL,
  nodeId TEXT NOT NULL, attempt INTEGER NOT NULL, recordJson TEXT NOT NULL,
  updatedAt INTEGER NOT NULL, PRIMARY KEY(scopeKey,runId,revision,nodeId,attempt)
);
CREATE TABLE IF NOT EXISTS workflow_owner_recoveries (
  recoveryId TEXT PRIMARY KEY, workspaceKey TEXT NOT NULL, ownerId TEXT NOT NULL,
  fencingToken INTEGER NOT NULL, evidenceKind TEXT NOT NULL, observedAt INTEGER NOT NULL
);
`
