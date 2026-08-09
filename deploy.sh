#!/usr/bin/env bash
# Release the usebench.dev control plane from a clean checkout.
#
# Usage:
#   ./deploy.sh [--environment production|staging]
#               [--yes] [--dry-run] [--skip-install] [--skip-checks]
#               [--skip-migrations] [--skip-verify] [--allow-dirty]
#               [--url URL]
#
# Required setup is intentionally kept outside this script: authenticated
# Wrangler access, existing D1/KV bindings, and the Worker secrets documented
# in README.md. Fleet daemon releases use the controller's drain, deploy,
# verify, and restore workflow; see infra/RUNBOOK.md for compatibility order.
set -Eeuo pipefail
IFS=$'\n\t'

readonly MIN_NODE_MAJOR=22

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

ASSUME_YES=false
DRY_RUN=false
SKIP_INSTALL=false
SKIP_CHECKS=false
SKIP_MIGRATIONS=false
SKIP_VERIFY=false
ALLOW_DIRTY=false
TARGET_ENVIRONMENT=production
WORKER_URL="${DEPLOY_URL:-}"

usage() {
  cat <<'EOF'
Usage: ./deploy.sh [options]

Release the Cloudflare Worker in this repository. By default the script:
  1. verifies Node.js 22+ and, for a real release, a clean checkout;
  2. installs the lockfile and release tooling with npm ci --include=dev;
  3. runs type checks and tests;
  4. applies pending remote D1 migrations;
  5. deploys the Worker; and
  6. requests the deployed Worker URL as a smoke test.

Options:
  --environment production|staging
                      Select the isolated control plane (default: production).
  --yes, -y           Do not ask before applying remote changes.
  --dry-run           Run local release gates and print remote actions only.
  --skip-install      Do not run npm ci.
  --skip-checks       Do not run type checks or tests.
  --skip-migrations   Do not apply remote D1 migrations.
  --skip-verify       Do not smoke-test the Worker URL.
  --allow-dirty       Permit deploying a checkout with uncommitted changes.
  --url URL           Worker URL to smoke-test (defaults to DEPLOY_URL or
                      BASE_URL in apps/worker/wrangler.jsonc).
  --help, -h          Show this help.

Examples:
  npm run deploy
  npm run deploy -- --yes
  npm run deploy -- --dry-run
  npm run deploy -- --environment staging --yes
EOF
}

info() {
  printf '\n==> %s\n' "$*"
}

warn() {
  printf '\nWARNING: %s\n' "$*" >&2
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

run() {
  printf '+ '
  printf '%q ' "$@"
  printf '\n'
  "$@"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

read_worker_url() {
  case "$TARGET_ENVIRONMENT" in
    production) printf '%s\n' "https://usebench.dev" ;;
    staging) printf '%s\n' "https://staging.usebench.dev" ;;
    *) return 1 ;;
  esac
}

worker_npm_script() {
  local production_script=$1
  if [[ "$TARGET_ENVIRONMENT" == staging ]]; then
    printf '%s:staging\n' "$production_script"
  else
    printf '%s\n' "$production_script"
  fi
}

confirm_remote_release() {
  local daemon_answer
  local remote_action

  if [[ "$SKIP_MIGRATIONS" == true ]]; then
    remote_action="Deploy the Worker"
  else
    remote_action="Apply remote D1 migrations and deploy the Worker"
  fi

  if [[ "$ASSUME_YES" == true ]]; then
    return
  fi

  if [[ ! -t 0 ]]; then
    die "Refusing a non-interactive release without --yes."
  fi

  read -r -p "Confirm daemon/shared-contract changes follow the compatibility order in infra/RUNBOOK.md [y/N] " daemon_answer
  if [[ ! "$daemon_answer" =~ ^[Yy]([Ee][Ss])?$ ]]; then
    info "Release cancelled."
    exit 0
  fi

  local answer
  read -r -p "$remote_action? [y/N] " answer
  if [[ ! "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]; then
    info "Release cancelled."
    exit 0
  fi
}

while (($#)); do
  case "$1" in
    --environment)
      (($# >= 2)) || die "--environment requires production or staging."
      TARGET_ENVIRONMENT=$2
      shift
      ;;
    --yes|-y)
      ASSUME_YES=true
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    --skip-install)
      SKIP_INSTALL=true
      ;;
    --skip-checks)
      SKIP_CHECKS=true
      ;;
    --skip-migrations)
      SKIP_MIGRATIONS=true
      ;;
    --skip-verify)
      SKIP_VERIFY=true
      ;;
    --allow-dirty)
      ALLOW_DIRTY=true
      ;;
    --url)
      (($# >= 2)) || die "--url requires a value."
      WORKER_URL="$2"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1 (run ./deploy.sh --help)"
      ;;
  esac
  shift
done

case "$TARGET_ENVIRONMENT" in
  production|staging) ;;
  *) die "--environment must be production or staging (got: $TARGET_ENVIRONMENT)" ;;
esac

cd "$ROOT_DIR"

info "Checking $TARGET_ENVIRONMENT release prerequisites"
require_command git
require_command node
require_command npm

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || \
  die "deploy.sh must run from a Git checkout."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if ((NODE_MAJOR < MIN_NODE_MAJOR)); then
  die "Node.js ${MIN_NODE_MAJOR}+ is required (found $(node --version))."
fi

WORKTREE_STATUS="$(git status --porcelain)" || \
  die "Could not inspect the Git working tree."
if [[ -n "$WORKTREE_STATUS" ]]; then
  if [[ "$DRY_RUN" == true ]]; then
    warn "Dry run is using a checkout with uncommitted changes; no remote changes will be made."
  elif [[ "$ALLOW_DIRTY" == false ]]; then
    die "The checkout has uncommitted changes. Commit or stash them, or pass --allow-dirty."
  else
    warn "Deploying a checkout with uncommitted changes."
  fi
fi

if [[ "$SKIP_VERIFY" == false ]] && [[ -z "$WORKER_URL" ]]; then
  WORKER_URL="$(read_worker_url)" || \
    die "Could not find BASE_URL in apps/worker/wrangler.jsonc; pass --url URL."
fi

if [[ "$SKIP_VERIFY" == false ]]; then
  require_command curl
  [[ "$WORKER_URL" =~ ^https?:// ]] || \
    die "Worker URL must start with http:// or https:// (got: $WORKER_URL)"
fi

if [[ "$SKIP_INSTALL" == false ]]; then
  info "Installing locked dependencies"
  run npm ci --include=dev
fi

if [[ "$SKIP_CHECKS" == false ]]; then
  info "Building browser clients"
  run npm run build:client -w apps/worker

  info "Running type checks"
  run npm run typecheck

  info "Running lint"
  run npm run lint

  info "Running tests"
  run npm test
fi

if [[ "$DRY_RUN" == true ]]; then
  info "Dry run complete"
  if [[ "$SKIP_MIGRATIONS" == false ]]; then
    printf 'Would run: npm run %s -w apps/worker\n' "$(worker_npm_script db:migrate:remote)"
  fi
  printf 'Would run: npm run %s -w apps/worker\n' "$(worker_npm_script deploy)"
  if [[ "$SKIP_VERIFY" == false ]]; then
    printf 'Would request: %s/\n' "${WORKER_URL%/}"
  fi
  exit 0
fi

warn "This command deploys only the Worker. Use 'npm run hostctl -- deploy' for fleet daemon releases per infra/RUNBOOK.md."
confirm_remote_release

if [[ "$SKIP_MIGRATIONS" == false ]]; then
  info "Applying remote D1 migrations"
  warn "Remote D1 migrations do not roll back automatically."
  run npm run "$(worker_npm_script db:migrate:remote)" -w apps/worker
fi

info "Deploying the $TARGET_ENVIRONMENT Cloudflare Worker"
run npm run "$(worker_npm_script deploy)" -w apps/worker

if [[ "$SKIP_VERIFY" == false ]]; then
  info "Smoke-testing the deployed Worker"
  run curl --fail --silent --show-error \
    --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 30 \
    -o /dev/null "${WORKER_URL%/}/"
fi

info "Deployment completed successfully"
