-- Migrate Sign in with World ID from SIWO (OIDC) to World ID 4.0 Session proofs.
-- `session_id` is the stable per-(RP, human) identifier IDKit returns from
-- createSession/proveSession; it replaces the OIDC `sub`.
ALTER TABLE users RENAME COLUMN world_id_oidc_sub TO world_id_session_id;
