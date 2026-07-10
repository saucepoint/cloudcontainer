-- Repository choices are non-secret provisioning metadata. OAuth tokens remain
-- encrypted in credentials_encrypted and are never stored with jobs.
ALTER TABLE containers ADD COLUMN github_repos TEXT NOT NULL DEFAULT '[]';

-- Remember the safe in-app destination for an OAuth round trip so onboarding
-- can connect GitHub before the container exists.
ALTER TABLE oauth_states ADD COLUMN return_to TEXT NOT NULL DEFAULT '/dashboard';
