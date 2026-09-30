-- Journal task files belong to the knowledge base; journal_meta.project_id still records the owning project.
UPDATE files SET project_id = NULL WHERE id IN (SELECT file_id FROM journal_meta) AND project_id IS NOT NULL;
