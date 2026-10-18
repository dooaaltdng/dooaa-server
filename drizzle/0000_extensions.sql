-- Trigram indexes back the substring searches (catalog fallback, suggest, console search).
-- pg_trgm is a trusted extension: the database owner can create it without superuser rights.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
