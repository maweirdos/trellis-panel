/** Additive tables on the existing owned database; bodies use the existing blobs table. */
export const TEAM_TASK_MATERIALS_SQL = `
CREATE TABLE task_material_documents(
 documentId TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(projectId),
 taskId TEXT NOT NULL,spaceId TEXT NOT NULL,taskCreatedAt TEXT NOT NULL,kind TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),recordJson TEXT NOT NULL,
 UNIQUE(projectId,taskId,spaceId,taskCreatedAt,kind)
);
CREATE INDEX task_material_documents_task ON task_material_documents(projectId,taskId,spaceId,taskCreatedAt,documentId);
CREATE TABLE task_material_versions(
 versionId TEXT PRIMARY KEY,documentId TEXT NOT NULL REFERENCES task_material_documents(documentId),
 number INTEGER NOT NULL CHECK(number>0),bodyDigest TEXT NOT NULL REFERENCES blobs(bodyDigest),
 metadataJson TEXT NOT NULL,UNIQUE(documentId,number)
);
CREATE INDEX task_material_versions_document ON task_material_versions(documentId,versionId);
CREATE TABLE task_material_submissions(
 submissionId TEXT PRIMARY KEY,documentId TEXT NOT NULL REFERENCES task_material_documents(documentId),
 versionId TEXT NOT NULL REFERENCES task_material_versions(versionId),metadataJson TEXT NOT NULL,
 UNIQUE(documentId,versionId)
);
CREATE INDEX task_material_submissions_document ON task_material_submissions(documentId,submissionId);
`
