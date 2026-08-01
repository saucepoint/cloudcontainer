-- Account-level developer service credentials, encrypted independently at rest.
ALTER TABLE credentials_encrypted ADD COLUMN supabase_token TEXT;
ALTER TABLE credentials_encrypted ADD COLUMN convex_token TEXT;
