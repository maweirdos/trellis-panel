export const CONTROL_PLANE_SCHEMA_VERSION = 1

export const CONTROL_PLANE_DDL = `
CREATE TABLE IF NOT EXISTS control_plane_sequence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  currentSequence INTEGER NOT NULL,
  storeEpoch TEXT NOT NULL,
  schemaVersion INTEGER NOT NULL,
  migratedAt INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS control_plane_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  eventId TEXT NOT NULL UNIQUE,
  conversationId TEXT NOT NULL,
  type TEXT NOT NULL,
  occurredAt INTEGER NOT NULL,
  payloadDigest TEXT NOT NULL,
  payload TEXT NOT NULL,
  FOREIGN KEY (conversationId) REFERENCES conversation_projection(conversationId) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS control_plane_events_conversation
  ON control_plane_events(conversationId, sequence);

CREATE TABLE IF NOT EXISTS conversation_projection (
  conversationId TEXT PRIMARY KEY,
  sourceRoot TEXT NOT NULL,
  sourceSessionId TEXT NOT NULL,
  sourceEngine TEXT NOT NULL,
  title TEXT NOT NULL,
  archivedAt INTEGER,
  pinnedAt INTEGER,
  lastActivityAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  lastSequence INTEGER NOT NULL,
  UNIQUE(sourceRoot, sourceSessionId, sourceEngine)
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_projection_root_activity
  ON conversation_projection(sourceRoot, archivedAt, lastActivityAt DESC, sourceSessionId DESC);

CREATE TABLE IF NOT EXISTS turn_projection (
  turnId TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  providerRuntimeId TEXT,
  startedAt INTEGER NOT NULL,
  endedAt INTEGER,
  FOREIGN KEY (conversationId) REFERENCES conversation_projection(conversationId) ON DELETE CASCADE,
  UNIQUE(conversationId, ordinal)
) STRICT;
CREATE INDEX IF NOT EXISTS turn_projection_conversation
  ON turn_projection(conversationId, ordinal);

CREATE TABLE IF NOT EXISTS turn_item_projection (
  id TEXT PRIMARY KEY,
  turnId TEXT NOT NULL,
  conversationId TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  sourceEventId TEXT NOT NULL,
  sourceSequence INTEGER NOT NULL,
  occurredAt INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  FOREIGN KEY (conversationId) REFERENCES conversation_projection(conversationId) ON DELETE CASCADE,
  FOREIGN KEY (turnId) REFERENCES turn_projection(turnId) ON DELETE CASCADE,
  UNIQUE(conversationId, sourceEventId)
) STRICT;
CREATE INDEX IF NOT EXISTS turn_item_projection_conversation_order
  ON turn_item_projection(conversationId, sourceSequence DESC);
CREATE INDEX IF NOT EXISTS turn_item_projection_sequence
  ON turn_item_projection(sequence);

CREATE TABLE IF NOT EXISTS runtime_session_projection (
  runtimeSessionId TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL,
  state TEXT NOT NULL,
  lastObservedAt INTEGER,
  recoverable INTEGER NOT NULL,
  engine TEXT NOT NULL,
  FOREIGN KEY (conversationId) REFERENCES conversation_projection(conversationId) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS runtime_session_projection_conversation
  ON runtime_session_projection(conversationId);

CREATE TABLE IF NOT EXISTS runtime_thread_projection (
  runtimeThreadId TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL,
  runtimeSessionId TEXT NOT NULL,
  nativeThreadId TEXT,
  identityStrength TEXT NOT NULL,
  recoverability TEXT NOT NULL,
  FOREIGN KEY (conversationId) REFERENCES conversation_projection(conversationId) ON DELETE CASCADE,
  FOREIGN KEY (runtimeSessionId) REFERENCES runtime_session_projection(runtimeSessionId) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS runtime_thread_projection_conversation
  ON runtime_thread_projection(conversationId);

CREATE TABLE IF NOT EXISTS provider_instance_projection (
  providerInstanceId TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL,
  launchKind TEXT NOT NULL,
  providerId TEXT NOT NULL,
  providerName TEXT,
  snapshotDigest TEXT,
  capabilityProjection TEXT,
  FOREIGN KEY (conversationId) REFERENCES conversation_projection(conversationId) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS provider_instance_projection_conversation
  ON provider_instance_projection(conversationId);

CREATE TABLE IF NOT EXISTS control_plane_migration (
  root TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  engine TEXT NOT NULL,
  state TEXT NOT NULL,
  sourceLastSequence INTEGER,
  sourceEventCount INTEGER NOT NULL,
  projectedEventCount INTEGER NOT NULL,
  sourceDigest TEXT NOT NULL,
  diagnostic TEXT,
  migratedAt INTEGER NOT NULL,
  PRIMARY KEY(root, sessionId, engine)
) STRICT;
CREATE INDEX IF NOT EXISTS control_plane_migration_state
  ON control_plane_migration(root, state);

CREATE TABLE IF NOT EXISTS control_plane_archive_progress (
  conversationId TEXT PRIMARY KEY,
  sourceEpoch TEXT NOT NULL,
  sourceSequence INTEGER NOT NULL,
  FOREIGN KEY (conversationId) REFERENCES conversation_projection(conversationId) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS control_plane_archive_item_payload (
  itemId TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL,
  payload TEXT NOT NULL,
  FOREIGN KEY (itemId) REFERENCES turn_item_projection(id) ON DELETE CASCADE,
  FOREIGN KEY (conversationId) REFERENCES conversation_projection(conversationId) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS control_plane_archive_item_conversation
  ON control_plane_archive_item_payload(conversationId, payload);

CREATE TABLE IF NOT EXISTS control_plane_v2_progress (
  conversationId TEXT PRIMARY KEY,
  sourceDigest TEXT NOT NULL,
  sourceOffset INTEGER NOT NULL,
  sourceCount INTEGER NOT NULL,
  FOREIGN KEY (conversationId) REFERENCES conversation_projection(conversationId) ON DELETE CASCADE
) STRICT;
`
