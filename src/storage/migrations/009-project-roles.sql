-- Migration 009: Replace admin/member roles with project-based roles
-- New roles: developer, qa, lead, devops
-- admin -> lead (admins typically had oversight role)
-- member -> developer (most common default)
UPDATE agent_tokens SET role = 'lead' WHERE role = 'admin';
UPDATE agent_tokens SET role = 'developer' WHERE role = 'member';
ALTER TABLE agent_tokens ALTER COLUMN role SET DEFAULT 'developer';
