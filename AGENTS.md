# Repository Guidelines

## Project at a glance

This is the Node.js 22, strict-ESM TypeScript workspace for usebench.dev. It
provisions one persistent Debian Incus system container per account with Pi,
Claude Code, Codex, and OpenCode available. The main runtime path is:

```text
browser -> Cloudflare Worker -> D1/job state -> signed + sealed RPC ->
Node daemon -> Incus container
```

The Worker serves both SSR HTML and JSON APIs; there is no separate Pages app.
Provisioning and lifecycle operations are asynchronous (usually HTTP 202), and
the five-minute Worker Cron invokes `reconcile` for convergence, waitlists, and
host health. Credentials are encrypted at rest in Worker storage, never put in
plaintext job rows or logs, and are sealed to the selected daemon for delivery.

Read only the source of truth needed for the task:

| Document | Use it for |
| --- | --- |
| `README.md` | Setup, secrets, local development, product flow, and release commands |
| `SPEC.md` | Normative product, architecture, state, security, and acceptance contract |
| `infra/RUNBOOK.md` | Host onboarding, fleet releases, rollback, and operational sequencing |
| `infra/MULTITENANT_TESTING.md` | Destructive multi-host/multi-tenant staging acceptance |
| `specs/` | Supporting reviews, audits, bug records, and verification evidence; not runtime code |

## Repository map

| Path | Responsibility |
| --- | --- |
| `packages/contract/src/` | Shared Zod wire schemas, resource/tier rules, Ed25519 signing, X25519 sealing, and crypto helpers |
| `apps/worker/src/` | Hono router, Better Auth, D1 access, placement/jobs/reconciliation, integrations, and SSR pages |
| `apps/worker/client/` | Browser bundles for landing, onboarding, dashboard, account, and security flows |
| `apps/worker/migrations/` | Ordered D1 migrations; the current highest migration is `0016_free_tier_cpu.sql` |
| `apps/worker/test/` | Worker tests with an in-memory database, real migrations, and mocked fetches |
| `apps/daemon/src/` | Node/Hono RPC server, in-memory job runner, provisioning, credential installation, and Incus adapter |
| `apps/daemon/test/` | Daemon tests with injected command execution; no real Incus required |
| `infra/` | `hostctl`, bootstrap/policy/audit scripts, base-image build, and operational docs |
| `deploy.sh` | Control-plane release gates, remote migrations, Worker deployment, and smoke test |

## Hot paths and common change points

Use this table as the first stop instead of searching the whole repository.

| Task | Read first | Focused tests |
| --- | --- | --- |
| Add/change a Worker route | `apps/worker/src/index.tsx` and the owning route module (`api.ts`, `account.ts`, `admin.ts`, `fleet-admin.ts`, `github.ts`, `subscriptions.ts`, or `codexauth.ts`) | `apps/worker/test/api.test.ts` or the matching feature test |
| Provision or change container lifecycle | `apps/worker/src/api.ts` -> `placement.ts` -> `jobs.ts` -> `daemon.ts`; status policy is in `state.ts` | `test/api.test.ts`, `test/jobs.test.ts`, `test/reconciler.test.ts` |
| Placement, capacity, or fleet health | `capacity.ts`, `host-health.ts`, `placement.ts`, `reconciler.ts`, and `fleet-admin.ts` | `test/reconciler.test.ts`, `test/jobs.test.ts`, `test/admin.test.ts` |
| Change SSR or dashboard behavior | `apps/worker/src/pages/views.tsx`, `layout.tsx`, `styles.ts`, then `apps/worker/client/dashboard.tsx`, `dashboard-model.ts`, `onboarding.ts`, or `ui.tsx` | `test/pages.test.ts`, `test/client.test.ts` |
| Auth, credentials, or provider integration | `auth.ts`, `better-auth.ts`, `credentials.ts`, `credential-input.ts`, `account.ts`, `world-id.ts`, `github.ts`, `subscriptions.ts`, `codexauth.ts` | `test/auth.test.ts`, `test/account.test.ts`, `test/credentials.test.ts`, `test/github.test.ts`, `test/subscriptions.test.ts`, `test/codexauth.test.ts` |
| Change daemon job/provision behavior | `apps/daemon/src/index.ts` -> `jobs.ts` -> `provisioner.ts` -> `incus.ts`; inspect `credential-installer.ts`, `config.ts`, and `motd.ts` when relevant | `test/server.test.ts`, `test/jobs.test.ts`, `test/provisioner.test.ts`, `test/incus.test.ts` |
| Change the Worker/daemon wire contract | `packages/contract/src/types.ts`, `signing.ts`, and `crypto.ts`; both services import the public surface from `index.ts` | All `packages/contract/test/*` plus affected Worker/daemon tests |
| Change D1 state | The latest migration plus `apps/worker/src/types.ts` and `test/helpers/env.ts` | `test/migrations.test.ts` plus affected feature tests |
| Change host operations | `infra/hostctl.sh` and `infra/RUNBOOK.md`; use `bootstrap.sh` only for new hosts and `build-image.sh` for image changes | `infra/MULTITENANT_TESTING.md` for staging evidence |

The most frequently revisited files are the Worker router/API, `jobs.ts`,
`reconciler.ts`, `pages/views.tsx`, `pages/styles.ts`, the corresponding API,
jobs, reconciler, and pages tests, daemon `provisioner.ts`, and contract
`types.ts`. Keep changes narrow in these high-fan-out files.

## Commands

Run from the repository root unless a command says otherwise.

| Purpose | Command | Notes |
| --- | --- | --- |
| Install locked dependencies | `npm ci` | Node.js 22 required |
| Build browser clients | `npm run build:client -w apps/worker` | Run after client changes; bundles go under `apps/worker/public/` |
| Type-check everything | `npm run typecheck` | Worker type generation and client type-check are included |
| Lint code and shell | `npm run lint` | Runs oxlint and `bash -n` over release/infra scripts |
| Run all tests | `npm test` | Vitest; external Cloudflare, GitHub, World ID, and Incus calls are mocked |
| Test one workspace | `npm test -w apps/worker` / `npm test -w apps/daemon` / `npm test -w packages/contract` | Use the workspace matching the change |
| Test one file | `npm run test -w apps/worker -- test/api.test.ts` | Replace the path with the focused test |
| Local D1 migration | `npm run db:migrate:local -w apps/worker` | Run before local Worker development after schema changes |
| Local Worker | `npm run dev:worker` | Builds clients via `predev`; normally serves port 8787 |
| Local Worker with login bypass | `(cd apps/worker && npx wrangler dev --var DEV_AUTH:1)` | Local-only; never commit or deploy `DEV_AUTH=1` |
| Local daemon | `npm run dev:daemon` | Watches `apps/daemon/src/index.ts` |
| Generate service keys | `(cd apps/worker && npx tsx scripts/genkeys.ts)` | Keep private keys and generated secrets out of the repository |
| Generate an invite | `npm run create:invite -- --url https://YOUR_BASE_URL` | Requires `INVITE_ADMIN_SECRET`; pass secrets via the environment, not argv |
| Remote D1 migration | `npm run db:migrate:remote -w apps/worker` | Release operation; review migrations and compatibility first |
| Release dry run | `npm run deploy:dry-run` | Runs local release gates and prints remote actions |
| Release control plane | `npm run deploy` | Prompts, applies remote D1 migrations, deploys the Worker, and smoke-tests it |
| Non-interactive release | `npm run deploy -- --yes` | Remote mutation; use only intentionally |
| List fleet hosts | `npm run hostctl -- list` | Requires `FLEET_ADMIN_SECRET` or an interactive prompt |
| Dry-run daemon fleet release | `npm run hostctl -- deploy --all --dry-run` | Read `infra/RUNBOOK.md` before a real fleet change |
| Recalculate host capacity | `npm run hostctl -- capacity HOST_ID` | Drains/re-registers/probes a host; operational mutation |

Use `./deploy.sh --help` and `npm run hostctl -- --help` for all release and
fleet options. `hostctl onboard` is the supported new-host path; do not run
bootstrap as an update mechanism or construct host rows with ad hoc SQL.

## Local worktrees

The repository root is the primary `main` checkout. Create linked task
worktrees under `.worktrees/<task-name>` so parallel changes stay contained.
`.worktrees/` is excluded locally through `.git/info/exclude`; do not add it to
the shared `.gitignore` or commit its contents. Each worktree has its own
dependencies and local configuration; never copy credentials, `.dev.vars`, or
daemon configuration between worktrees.

```sh
git worktree add -b feat/<name> .worktrees/<name> main
git worktree add .worktrees/<name> feat/<name>
git worktree list
git worktree remove .worktrees/<name>
git worktree prune
```

## Coding and testing conventions

Use strict ESM TypeScript with two-space indentation, double quotes,
semicolons, trailing commas, `.js` relative imports, and `import type` for
type-only imports. Use `camelCase` values/functions, `PascalCase` types, and
`UPPER_SNAKE_CASE` constants. There is no formatter; preserve surrounding
formatting. The configured lint command is `npm run lint`.

Place tests in the matching workspace's `test/` directory as `<area>.test.ts`.
Use Vitest `describe`/`it`/`expect`. Mock external services rather than
contacting Cloudflare, GitHub, World ID, or Incus. Worker tests use the
in-memory environment and real migrations; daemon tests inject command
execution. Add a focused regression test for each behavior change.

## Security, migrations, and releases

Never commit or log credentials, `.dev.vars`, daemon configuration, TLS keys,
or generated secrets. Keep credential values out of job records and error
messages. `apps/worker/worker-configuration.d.ts` and Wrangler state are
generated/ignored; do not hand-edit them.

Add D1 migrations in numeric order (the next migration after `0016` is the
current starting point), and use expand-first, backward-compatible changes:
D1 migrations do not roll back automatically. A contract change can affect the
Worker, daemon, and infrastructure release order; update schemas/tests first,
then follow the compatibility sequence in `SPEC.md` and `infra/RUNBOOK.md`.

## Commits and pull requests

History favors brief lowercase summaries, with occasional Conventional Commit
forms such as `feat(auth): ...` and `fix: ...`. Prefer concise imperative
subjects. Keep pull requests focused and include the summary, validation
commands, linked issue when applicable, screenshots for dashboard changes, and
explicit migration or coordinated-release notes for cross-service work.
