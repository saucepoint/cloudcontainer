# Staging environment impact

## Target

Create `staging.usebench.dev` with an independent Cloudflare Worker, D1 database, secrets, Worker-to-daemon signing key, fleet inventory, and daemon instance while allowing staging and production to share physical Incus hosts safely.

## Dependents (18)

- `apps/worker/wrangler.jsonc`: Worker names, custom domains, D1 bindings, Cron, public variables, and generated binding types.
- `apps/worker/package.json`: environment-specific deploy and D1 migration commands.
- `deploy.sh`: control-plane release target, migration target, and smoke-test URL.
- `apps/worker/src/types.ts`: generated Worker variables widened for runtime use.
- `apps/worker/src/ports.ts`: SSH proxy allocation; separate D1 databases cannot detect cross-environment port collisions.
- `apps/worker/src/placement.ts` and `apps/worker/src/reconciler.ts`: all host reservations call the port allocator.
- `apps/worker/test/ports.test.ts` and `apps/worker/test/helpers/env.ts`: port-range and binding coverage.
- `infra/hostctl.sh`: control-plane URL, remote release/config roots, daemon service, project policy, registration, audit, and rollout.
- `infra/bootstrap.sh`: daemon config, key, service, project, and registration installation paths.
- `infra/host-policy.sh`: physical CPU/RAM/disk/idmap capacity currently assumes one control plane owns the full host.
- `infra/configure-multitenant.sh`: Incus project ceilings.
- `infra/report-host-capacity.sh`: D1 registration capacity.
- `infra/audit-multitenant.sh`: daemon service and project policy checks.
- `apps/daemon/systemd/workbench-daemon.service`: production-only config/release/source paths.
- `apps/daemon/src/config.ts` and `apps/daemon/src/index.ts`: one signing key and one Incus project per daemon process; a second process is required for staging.
- `README.md`, `SPEC.md`, and `infra/RUNBOOK.md`: setup, architecture, release, rollback, and shared-host safety contract.

## Affected stories / release contract

- Control plane changes from one deployment to independent production and staging deployments.
- Fleet operations gain environment selection; production remains the default and must not be changed by an omitted flag.
- Shared physical hosts require distinct daemon processes, configs, X25519 keys, Worker signing keys, Incus projects, release trees, service names, daemon ports, and SSH proxy port ranges.
- Physical capacity must be statically partitioned across control planes. Independent D1 databases cannot coordinate reservations, so registering full host capacity in both is unsafe.
- No D1 schema or Worker/daemon wire-schema change is required.

## Test coverage

- Add Worker tests for configured SSH port ranges and invalid range fail-closed behavior.
- Add daemon/infra tests for environment-specific remote roots, config paths, services, projects, and tenant caps.
- Validate Wrangler configuration/types and environment-specific dry runs.
- Run browser build, repository typecheck, lint, and all tests.
- Remote verification: migrate the staging D1, deploy `workbench-staging`, smoke-test `staging.usebench.dev`, install/probe the staging daemon, and verify production inventory remains unchanged.
- Manual shared-host check: confirm production and staging Incus projects, services, daemon ports, and SSH ranges are disjoint, and confirm the sum of project tenant caps does not exceed the physical safe ceiling.

## Risk: High

Two independent schedulers sharing one physical host can overcommit resources or allocate the same host SSH port unless the host is explicitly partitioned. A staging rollout can also restart or overwrite production if paths and systemd service names are not environment-scoped.

## Recommended action

Proceed expand-first: add environment-aware control-plane commands and fail-closed SSH ranges; add instance-scoped daemon deployment and static tenant caps; verify locally; create and migrate staging D1; configure independent secrets; deploy the staging Worker; then partition one drained production host before registering and activating its staging daemon. Keep production as every command's explicit or default target and never reuse production cryptographic secrets in staging.
