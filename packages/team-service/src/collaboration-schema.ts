/** Additive schema. Existing immutable feedback and command tables remain authoritative. */
export const TEAM_COLLABORATION_SQL = `
CREATE TABLE collaboration(entityId TEXT PRIMARY KEY,kind TEXT NOT NULL,materialId TEXT NOT NULL,version INTEGER NOT NULL,projectId TEXT NOT NULL REFERENCES projects(projectId),creatorId TEXT NOT NULL REFERENCES people(userId),revision INTEGER NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,dataJson TEXT NOT NULL,FOREIGN KEY(materialId,version) REFERENCES material_versions(materialId,version));
CREATE INDEX collaboration_project ON collaboration(projectId,entityId);
CREATE TABLE collaboration_scope(entityId TEXT NOT NULL REFERENCES collaboration(entityId),materialId TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(entityId,materialId,version),FOREIGN KEY(materialId,version) REFERENCES material_versions(materialId,version));
CREATE TABLE collaboration_history(entityId TEXT NOT NULL REFERENCES collaboration(entityId),revision INTEGER NOT NULL,action TEXT NOT NULL,actorJson TEXT NOT NULL,recordJson TEXT NOT NULL,PRIMARY KEY(entityId,revision));
CREATE TABLE collaboration_replies(replyId TEXT PRIMARY KEY,entityId TEXT NOT NULL REFERENCES collaboration(entityId),parentReplyId TEXT REFERENCES collaboration_replies(replyId),body TEXT NOT NULL,actorJson TEXT NOT NULL,createdAt INTEGER NOT NULL);
CREATE INDEX collaboration_replies_entity ON collaboration_replies(entityId,replyId);
CREATE TABLE collaboration_reports(reportId TEXT PRIMARY KEY,entityId TEXT NOT NULL REFERENCES collaboration(entityId),reportJson TEXT NOT NULL,createdAt INTEGER NOT NULL);
CREATE INDEX collaboration_reports_entity ON collaboration_reports(entityId,reportId);
CREATE TABLE collaboration_dispositions(dispositionId TEXT PRIMARY KEY,entityId TEXT NOT NULL REFERENCES collaboration(entityId),feedbackId TEXT NOT NULL REFERENCES feedback(feedbackId),dispositionJson TEXT NOT NULL,createdAt INTEGER NOT NULL);
CREATE INDEX collaboration_dispositions_entity ON collaboration_dispositions(entityId,dispositionId);
`
