export const TEAM_IMPORTS_SQL = `
CREATE TABLE import_namespaces(namespaceId TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(projectId),enrollmentKey TEXT NOT NULL,spaceId TEXT NOT NULL,recordJson TEXT NOT NULL,UNIQUE(projectId,enrollmentKey));
CREATE TABLE import_batches(importId TEXT PRIMARY KEY,namespaceId TEXT NOT NULL REFERENCES import_namespaces(namespaceId),manifestDigest TEXT NOT NULL,manifestJson TEXT NOT NULL,createdBy TEXT NOT NULL REFERENCES people(userId),createdAt INTEGER NOT NULL);
CREATE INDEX import_batches_namespace ON import_batches(namespaceId,importId);
CREATE TABLE import_task_mappings(namespaceId TEXT NOT NULL REFERENCES import_namespaces(namespaceId),sourceTaskKey TEXT NOT NULL,recordJson TEXT NOT NULL,PRIMARY KEY(namespaceId,sourceTaskKey));
CREATE TABLE import_candidates(candidateId TEXT PRIMARY KEY,namespaceId TEXT NOT NULL REFERENCES import_namespaces(namespaceId),importId TEXT NOT NULL REFERENCES import_batches(importId),itemKey TEXT NOT NULL,versionKey TEXT NOT NULL,bodyDigest TEXT NOT NULL REFERENCES blobs(bodyDigest),recordJson TEXT NOT NULL,UNIQUE(namespaceId,itemKey,versionKey));
CREATE INDEX import_candidates_source ON import_candidates(namespaceId,itemKey,candidateId);
CREATE TABLE import_item_receipts(importId TEXT NOT NULL REFERENCES import_batches(importId),itemKey TEXT NOT NULL,recordJson TEXT NOT NULL,PRIMARY KEY(importId,itemKey));
`
