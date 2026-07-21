# Repository Guidelines

## Project Structure & Module Organization

This Node 22 TypeScript npm workspace has three units. `packages/contract/src/` owns shared Zod schemas and cryptography; keep protocol changes compatible with both services. `apps/worker/` contains Hono/Cloudflare SSR and API code, D1 migrations in `migrations/`, and Worker tests. `apps/daemon/` contains the Node/Hono Incus daemon, systemd unit, and tests. `infra/` holds host bootstrap, image-build, and operational scripts. Use `README.md` for setup and `SPEC.md` as the release contract.

Place tests in the matching workspace's `test/` directory as `<area>.test.ts`. Add database migrations in order, for example `apps/worker/migrations/0008_feature_name.sql`.

## Build, Test, and Development Commands

```sh
npm ci                 # install locked dependencies
npm run typecheck      # type-check every workspace
npm run lint           # lint TypeScript and validate shell syntax
npm test               # run all Vitest suites
npm run dev:worker     # run the Worker with Wrangler
npm run dev:daemon     # watch the daemon locally
```

For Worker database work, run `cd apps/worker && npm run db:migrate:local` before Wrangler. `DEV_AUTH=1` is strictly local-only. Use `npm run deploy -- --dry-run` to exercise release gates without remote changes; follow `infra/RUNBOOK.md` for host changes.

## Local Git Worktrees

The repository root is the primary `main` checkout. Create linked task worktrees beneath `.worktrees/<task-name>` so parallel changes stay contained in this repository. This directory is excluded locally through `.git/info/exclude`; do not add it to the shared `.gitignore` or commit its contents.

```sh
git worktree add -b feat/<name> .worktrees/<name> main  # new branch
git worktree add .worktrees/<name> feat/<name>           # existing branch
git worktree list
git worktree remove .worktrees/<name>
git worktree prune
```

Each worktree has its own dependencies and local configuration. Do not copy credentials, `.dev.vars`, or daemon configuration between worktrees.

## Coding Style & Naming Conventions

Write strict ESM TypeScript. Match the existing style: two-space indentation, double quotes, semicolons, trailing commas, and `.js` relative imports. Use `camelCase` for values/functions, `PascalCase` for types/interfaces, and `UPPER_SNAKE_CASE` for constants. Prefer `import type` for type-only imports. No formatter or linter is configured; preserve surrounding formatting and run `npm run typecheck`.

## Testing Guidelines

Use Vitest with `describe`, `it`, and `expect`; mock external services rather than contacting Cloudflare, GitHub, or Incus. Worker tests use the in-memory environment and real migrations; daemon tests inject command execution. Add a focused regression test for each behavior change. No coverage threshold is defined.

## Security, Migrations, and Releases

Never commit or log credentials, `.dev.vars`, daemon configuration, TLS keys, or generated secrets. Keep credential values out of job records and error messages. Review D1 migrations carefully: they do not roll back automatically, so make shared contract/schema changes backward compatible and expand-first. Coordinate daemon, Worker, and infrastructure releases through the runbook.

## Commits & Pull Requests

History favors brief lowercase summaries, with occasional Conventional Commit forms such as `feat(auth): ...` and `fix: ...`. Prefer concise imperative subjects; use `<type>(scope): summary` when it adds clarity. Keep pull requests focused and include a summary, validation commands run, linked issue when applicable, screenshots for dashboard changes, and explicit migration or release notes for cross-service work.
