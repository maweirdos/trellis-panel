export const CONVERSATION_ATTACHMENT_DDL = `
CREATE TABLE IF NOT EXISTS conversation_v2_attachment_content (
  content_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'image')),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  pasted_text INTEGER NOT NULL CHECK (pasted_text IN (0, 1)),
  bytes BLOB NOT NULL CHECK (length(bytes) = size_bytes)
) STRICT;

CREATE TABLE IF NOT EXISTS conversation_v2_attachment_knowledge (
  content_id TEXT PRIMARY KEY REFERENCES conversation_v2_attachment_content(content_id) ON DELETE CASCADE,
  reference_json TEXT NOT NULL CHECK (json_valid(reference_json))
) STRICT;

CREATE TABLE IF NOT EXISTS conversation_v2_attachment_drafts (
  content_id TEXT PRIMARY KEY REFERENCES conversation_v2_attachment_content(content_id),
  owner_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  root_key TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_attachment_drafts_scope
  ON conversation_v2_attachment_drafts(owner_id, space_id, root_key, draft_id, expires_at);
CREATE INDEX IF NOT EXISTS conversation_v2_attachment_drafts_expiry
  ON conversation_v2_attachment_drafts(expires_at);

CREATE TABLE IF NOT EXISTS conversation_v2_attachment_claims (
  attachment_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES conversation_v2_projection_threads(thread_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  claim_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  content_id TEXT NOT NULL REFERENCES conversation_v2_attachment_content(content_id),
  source_attachment_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  root_key TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  UNIQUE (thread_id, claim_id, ordinal)
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_v2_attachment_claims_content
  ON conversation_v2_attachment_claims(content_id);
`
