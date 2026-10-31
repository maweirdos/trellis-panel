export const TEAM_GOVERNANCE_SQL = `
CREATE TABLE governance_packages(packageId TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(projectId),spaceId TEXT NOT NULL,revision INTEGER NOT NULL,recordJson TEXT NOT NULL);
CREATE INDEX governance_space ON governance_packages(projectId,spaceId,packageId);
CREATE TABLE governance_versions(versionId TEXT PRIMARY KEY,packageId TEXT NOT NULL REFERENCES governance_packages(packageId),number INTEGER NOT NULL,bodyDigest TEXT NOT NULL REFERENCES blobs(bodyDigest),recordJson TEXT NOT NULL,UNIQUE(packageId,number));
CREATE TABLE governance_publications(packageId TEXT NOT NULL REFERENCES governance_packages(packageId),versionId TEXT NOT NULL REFERENCES governance_versions(versionId),publishedBy TEXT NOT NULL,publishedAt INTEGER NOT NULL,withdrawnBy TEXT,withdrawnAt INTEGER,reason TEXT,PRIMARY KEY(packageId,versionId));
CREATE TABLE task_input_heads(projectId TEXT NOT NULL REFERENCES projects(projectId),taskId TEXT NOT NULL,spaceId TEXT NOT NULL,taskCreatedAt TEXT NOT NULL,revision INTEGER NOT NULL,currentBundleId TEXT,PRIMARY KEY(projectId,taskId,spaceId,taskCreatedAt));
CREATE TABLE task_input_bundles(bundleId TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(projectId),taskId TEXT NOT NULL,spaceId TEXT NOT NULL,taskCreatedAt TEXT NOT NULL,revision INTEGER NOT NULL,recordJson TEXT NOT NULL,UNIQUE(projectId,taskId,spaceId,taskCreatedAt,revision));
CREATE TABLE task_input_withdrawals(documentId TEXT NOT NULL REFERENCES task_material_documents(documentId),versionId TEXT NOT NULL REFERENCES task_material_versions(versionId),withdrawnBy TEXT NOT NULL,withdrawnAt INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(documentId,versionId));
`
