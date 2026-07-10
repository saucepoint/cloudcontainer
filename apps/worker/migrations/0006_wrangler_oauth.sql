-- Cloudflare wrangler OAuth login ("Sign in with Cloudflare"): encrypted b64
-- JSON {oauth_token, refresh_token, expiration_time, scopes}, written into the
-- container as wrangler's config/default.toml by the daemon.
ALTER TABLE credentials_encrypted ADD COLUMN wrangler_oauth TEXT;
