# Security review: staging environment and shared-host isolation

**Scope:** working-tree staging environment changes
**Result:** PASS — no findings at confidence ≥ 8/10

## Trust-boundary review

### Cloudflare control planes

- Production and staging use distinct Worker scripts, D1 databases, custom domains, Cron triggers, Better Auth secrets, credential master keys, invite/fleet administrator secrets, and Worker RPC signing keys.
- Wrangler environment bindings and secrets are non-inheritable; staging provider IDs default to empty so production OAuth or World ID settings are not accidentally exposed.
- Staging tenant SSH allocation is restricted to ports 40000–49999 while production remains on 30000–39999. Invalid range configuration fails closed.

### Shared physical host

- Staging has a separate release tree, root-owned config tree, systemd service, daemon listener, Worker signing trust root, X25519 key, Incus project, host identity, and D1 fleet row.
- Shared-host staging bootstrap verifies existing production infrastructure and does not reinstall packages, rewrite nftables, or restart Incus. This prevents a staging setup from disrupting production tenants.
- The independent schedulers are constrained by static `HOST_TENANT_LIMIT` partitions. Staging setup fails if production plus staging project caps exceed the physical resource-derived ceiling or if project host classes differ. Production capacity changes automatically include an existing staging project in the same check.
- Host controller values interpolated into remote shell operations are fixed environment constants or validated IDs, host classes, integers, hostnames, paths, and URLs. Secrets remain in a mode-0600 curl config or are supplied through environment/stdin paths; no secret value is added to source, command output, D1 jobs, or daemon logs.

### Data and request paths

- Worker HTTP authentication, fleet bearer comparison, signed daemon RPC verification, sealed credential delivery, D1 query parameterization, and tenant ownership checks are unchanged.
- A staging Worker cannot send a valid request to a production daemon because the daemon accepts exactly one environment-specific Ed25519 public key.
- Separate Incus projects prevent either daemon from enumerating or mutating the other environment's tenant containers and custom volumes.

## Findings

No command injection, auth bypass, cross-environment IDOR, secret exposure, unsafe deserialization, SQL injection, XSS, SSRF, or cryptographic-key reuse finding met the 8/10 reporting threshold. Wrangler 4.120.0 and lockfile-only Hono/nanoid patches were applied after newly published advisories were detected; `npm audit --audit-level=high` reports zero vulnerabilities.
