/**
 * New-generation conversation storage. No V1 table is read or migrated.
 * Every projection row keeps its source event sequence so replay stays auditable.
 */
export const CONVERSATION_SCHEMA_VERSION = 2

export const CONVERSATION_DDL = `
CREATE TABLE IF NOT EXISTS conversation_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS conversation_v2_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  command_id TEXT,
  thread_id TEXT NOT NULL,
  run_id TEXT,
  node_id TEXT,
  provider TEXT,
  provider_instance_id TEXT,
  raw_event_id TEXT,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_events_command_idx
  ON conversation_v2_events(command_id, sequence);
CREATE INDEX IF NOT EXISTS conversation_v2_events_thread_sequence_idx
  ON conversation_v2_events(thread_id, sequence);
CREATE INDEX IF NOT EXISTS conversation_v2_events_thread_type_sequence_idx
  ON conversation_v2_events(thread_id, event_type, sequence);
CREATE INDEX IF NOT EXISTS conversation_v2_events_run_sequence_idx
  ON conversation_v2_events(run_id, sequence);
CREATE INDEX IF NOT EXISTS conversation_v2_events_raw_event_idx
  ON conversation_v2_events(raw_event_id);

CREATE TABLE IF NOT EXISTS conversation_v2_command_receipts (
  command_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  result_sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  error TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_command_receipts_thread_sequence_idx
  ON conversation_v2_command_receipts(thread_id, result_sequence);

CREATE TABLE IF NOT EXISTS conversation_v2_effect_outbox (
  effect_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  last_error TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_effect_outbox_claim_idx
  ON conversation_v2_effect_outbox(status, available_at, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS conversation_v2_effect_outbox_command_idx
  ON conversation_v2_effect_outbox(command_id, effect_id);
CREATE INDEX IF NOT EXISTS conversation_v2_effect_outbox_thread_status_idx
  ON conversation_v2_effect_outbox(thread_id, effect_type, status);
CREATE INDEX IF NOT EXISTS conversation_v2_effect_outbox_thread_run_idx
  ON conversation_v2_effect_outbox(thread_id, effect_type, json_extract(payload_json, '$.runId'));

CREATE TABLE IF NOT EXISTS conversation_v2_projection_threads (
  thread_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  title TEXT NOT NULL,
  default_provider TEXT NOT NULL,
  runtime_mode TEXT NOT NULL,
  interaction_mode TEXT NOT NULL,
  active_provider_thread_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT,
  payload_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_projection_threads_project_updated_idx
  ON conversation_v2_projection_threads(project_id, updated_at);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_threads_owner_space_idx
  ON conversation_v2_projection_threads(owner_id, space_id, updated_at);

CREATE TABLE IF NOT EXISTS conversation_v2_projection_runs (
  run_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  provider_thread_id TEXT,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  payload_json TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS conversation_v2_projection_runs_thread_ordinal_idx
  ON conversation_v2_projection_runs(thread_id, ordinal);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_runs_provider_thread_idx
  ON conversation_v2_projection_runs(provider_thread_id);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_runs_thread_status_idx
  ON conversation_v2_projection_runs(thread_id, status);

CREATE TABLE IF NOT EXISTS conversation_v2_projection_run_attempts (
  attempt_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_ordinal INTEGER NOT NULL,
  root_node_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  provider_thread_id TEXT NOT NULL,
  provider_turn_id TEXT,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS conversation_v2_projection_run_attempts_run_ordinal_idx
  ON conversation_v2_projection_run_attempts(run_id, attempt_ordinal);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_run_attempts_thread_idx
  ON conversation_v2_projection_run_attempts(thread_id, run_id);

CREATE TABLE IF NOT EXISTS conversation_v2_projection_nodes (
  node_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  run_id TEXT,
  parent_node_id TEXT,
  root_node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  provider_instance_id TEXT,
  provider_thread_id TEXT,
  provider_turn_id TEXT,
  runtime_request_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  payload_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_projection_nodes_thread_run_idx
  ON conversation_v2_projection_nodes(thread_id, run_id);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_nodes_parent_idx
  ON conversation_v2_projection_nodes(parent_node_id);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_nodes_provider_turn_idx
  ON conversation_v2_projection_nodes(provider_turn_id);

CREATE TABLE IF NOT EXISTS conversation_v2_projection_provider_sessions (
  provider_session_id TEXT PRIMARY KEY,
  thread_id TEXT,
  provider TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_projection_provider_sessions_thread_idx
  ON conversation_v2_projection_provider_sessions(thread_id);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_provider_sessions_instance_status_idx
  ON conversation_v2_projection_provider_sessions(provider_instance_id, status);

CREATE TABLE IF NOT EXISTS conversation_v2_projection_provider_threads (
  provider_thread_id TEXT PRIMARY KEY,
  thread_id TEXT,
  owner_node_id TEXT,
  provider TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  provider_session_id TEXT,
  status TEXT NOT NULL,
  first_run_ordinal INTEGER,
  last_run_ordinal INTEGER,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_projection_provider_threads_thread_idx
  ON conversation_v2_projection_provider_threads(thread_id);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_provider_threads_session_idx
  ON conversation_v2_projection_provider_threads(provider_session_id);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_provider_threads_owner_idx
  ON conversation_v2_projection_provider_threads(owner_node_id);

CREATE TABLE IF NOT EXISTS conversation_v2_projection_provider_turns (
  provider_turn_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  provider_thread_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  run_attempt_id TEXT,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  payload_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_projection_provider_turns_thread_idx
  ON conversation_v2_projection_provider_turns(thread_id);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_v2_projection_provider_turns_thread_ordinal_idx
  ON conversation_v2_projection_provider_turns(provider_thread_id, ordinal);

CREATE TABLE IF NOT EXISTS conversation_v2_projection_runtime_requests (
  runtime_request_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  provider_turn_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  payload_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_projection_runtime_requests_thread_status_idx
  ON conversation_v2_projection_runtime_requests(thread_id, status);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_runtime_requests_provider_turn_idx
  ON conversation_v2_projection_runtime_requests(provider_turn_id);

CREATE TABLE IF NOT EXISTS conversation_v2_projection_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  run_id TEXT,
  node_id TEXT,
  role TEXT NOT NULL,
  streaming INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_projection_messages_thread_created_idx
  ON conversation_v2_projection_messages(thread_id, created_at, message_id);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_messages_run_idx
  ON conversation_v2_projection_messages(run_id);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_messages_node_idx
  ON conversation_v2_projection_messages(node_id);

CREATE TABLE IF NOT EXISTS conversation_v2_projection_plans (
  plan_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  run_id TEXT,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_projection_plans_thread_idx
  ON conversation_v2_projection_plans(thread_id);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_plans_run_idx
  ON conversation_v2_projection_plans(run_id);

CREATE TABLE IF NOT EXISTS conversation_v2_projection_turn_items (
  turn_item_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  run_id TEXT,
  node_id TEXT,
  provider_thread_id TEXT,
  provider_turn_id TEXT,
  parent_item_id TEXT,
  ordinal INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_projection_turn_items_thread_ordinal_idx
  ON conversation_v2_projection_turn_items(thread_id, ordinal, turn_item_id);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_turn_items_run_ordinal_idx
  ON conversation_v2_projection_turn_items(run_id, ordinal);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_turn_items_node_ordinal_idx
  ON conversation_v2_projection_turn_items(node_id, ordinal);
CREATE INDEX IF NOT EXISTS conversation_v2_projection_turn_items_provider_turn_idx
  ON conversation_v2_projection_turn_items(provider_turn_id);

CREATE TABLE IF NOT EXISTS conversation_v2_turn_item_positions (
  thread_id TEXT NOT NULL,
  turn_item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (thread_id, turn_item_id),
  UNIQUE (thread_id, ordinal)
) STRICT;

CREATE TABLE IF NOT EXISTS conversation_v2_provider_session_bindings (
  provider_session_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  PRIMARY KEY (provider_session_id, thread_id)
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_provider_session_bindings_thread_idx
  ON conversation_v2_provider_session_bindings(thread_id);

CREATE TABLE IF NOT EXISTS conversation_v2_thread_control (
  thread_id TEXT PRIMARY KEY REFERENCES conversation_v2_projection_threads(thread_id),
  authority_digest TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS conversation_v2_command_targets (
  command_id TEXT PRIMARY KEY,
  run_id TEXT,
  message_id TEXT,
  request_id TEXT,
  follows_run INTEGER NOT NULL CHECK (follows_run IN (0, 1)),
  detail TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS conversation_v2_dispatch_attempts (
  effect_id TEXT PRIMARY KEY REFERENCES conversation_v2_effect_outbox(effect_id),
  attempt_id TEXT NOT NULL UNIQUE,
  phase TEXT NOT NULL CHECK (phase IN ('preparing', 'dispatching', 'unknown', 'settled')),
  provider_thread_id TEXT,
  native_turn_id TEXT,
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0, 1)),
  foreground_ended INTEGER NOT NULL DEFAULT 0 CHECK (foreground_ended IN (0, 1)),
  background_running INTEGER NOT NULL DEFAULT 0 CHECK (background_running IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS conversation_v2_native_bindings (
  thread_id TEXT PRIMARY KEY REFERENCES conversation_v2_projection_threads(thread_id),
  instance_id TEXT NOT NULL,
  native_thread_id TEXT NOT NULL,
  configuration_fingerprint TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS conversation_v2_runtime_request_bindings (
  request_id TEXT PRIMARY KEY REFERENCES conversation_v2_projection_runtime_requests(runtime_request_id),
  attempt_id TEXT NOT NULL REFERENCES conversation_v2_dispatch_attempts(attempt_id),
  native_request_id TEXT NOT NULL,
  UNIQUE(attempt_id, native_request_id)
) STRICT;

CREATE TABLE IF NOT EXISTS conversation_v2_native_terminal_evidence (
  effect_id TEXT PRIMARY KEY REFERENCES conversation_v2_effect_outbox(effect_id),
  status TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  native_turn_id TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS conversation_v2_usage_limit_recoveries (
  thread_id TEXT PRIMARY KEY REFERENCES conversation_v2_projection_threads(thread_id),
  run_id TEXT NOT NULL,
  resume_at TEXT NOT NULL,
  retry_after_ms INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'cancelled', 'triggered')),
  reason TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS conversation_v2_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES conversation_v2_projection_threads(thread_id),
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('before', 'after')),
  cwd TEXT NOT NULL,
  git_tree_ref TEXT,
  head_ref TEXT,
  dirty_file_count INTEGER NOT NULL DEFAULT 0,
  untracked_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('captured', 'skipped', 'failed')),
  detail TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(thread_id, run_id, phase)
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_checkpoints_thread_created_idx
  ON conversation_v2_checkpoints(thread_id, created_at, checkpoint_id);

CREATE TABLE IF NOT EXISTS conversation_v2_checkpoint_scopes (
  checkpoint_id TEXT PRIMARY KEY REFERENCES conversation_v2_checkpoints(checkpoint_id) ON DELETE CASCADE,
  repo_root TEXT NOT NULL,
  canonical_cwd TEXT NOT NULL,
  git_ref_name TEXT,
  untracked_manifest_json TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS conversation_v2_session_approvals (
  thread_id TEXT NOT NULL REFERENCES conversation_v2_projection_threads(thread_id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, scope_key)
) STRICT;
`
