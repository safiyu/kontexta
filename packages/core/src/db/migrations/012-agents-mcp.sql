-- MCP registration state per agent, next to the hook columns.
ALTER TABLE agents ADD COLUMN mcp_supported INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN mcp_installed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN mcp_version TEXT;
ALTER TABLE agents ADD COLUMN mcp_installed_at TEXT;
ALTER TABLE agents ADD COLUMN mcp_approval TEXT NOT NULL DEFAULT 'prompt';
