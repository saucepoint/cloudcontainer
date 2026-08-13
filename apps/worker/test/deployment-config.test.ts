import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const wranglerConfig = readFileSync(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8",
);
const workerPackage = readFileSync(
  new URL("../package.json", import.meta.url),
  "utf8",
);
const rootDeploy = readFileSync(
  new URL("../../../deploy.sh", import.meta.url),
  "utf8",
);
const hostctl = readFileSync(
  new URL("../../../infra/hostctl.sh", import.meta.url),
  "utf8",
);

describe("staging deployment configuration", () => {
  it("uses an independent Worker, D1 database, domain, and SSH port range", () => {
    expect(wranglerConfig).toContain('"staging": {');
    expect(wranglerConfig).toContain('"name": "workbench-staging"');
    expect(wranglerConfig).toContain('"database_name": "workbench-staging"');
    expect(wranglerConfig).toContain('"pattern": "staging.usebench.dev"');
    expect(wranglerConfig).toContain('"BASE_URL": "https://staging.usebench.dev"');
    expect(wranglerConfig).toContain('"SSH_PORT_RANGE_START": "40000"');
    expect(wranglerConfig).toContain('"SSH_PORT_RANGE_END": "49999"');
  });

  it("accepts production billing enabled with live mode and durable queues declared", () => {
    const productionConfig = wranglerConfig.slice(0, wranglerConfig.indexOf('"env": {'));
    expect(productionConfig).toContain('"BILLING_ENABLED": "1"');
    expect(productionConfig).toContain('"STRIPE_LIVE_MODE": "1"');
    expect(productionConfig).toContain('"queue": "usebench-billing-events"');
    expect(productionConfig).toContain('"dead_letter_queue": "usebench-billing-events-dlq"');
  });

  it("keeps staging Stripe resources in sandbox mode", () => {
    const stagingConfig = wranglerConfig.slice(wranglerConfig.indexOf('"staging": {'));
    expect(stagingConfig).toContain('"STRIPE_LIVE_MODE": "0"');
  });

  it("provides environment-specific migration, deploy, and release commands", () => {
    expect(workerPackage).toContain('"db:migrate:remote:staging"');
    expect(workerPackage).toContain('"deploy:staging"');
    expect(rootDeploy).toContain("--environment production|staging");
    expect(rootDeploy).toContain("worker_npm_script db:migrate:remote");
    expect(rootDeploy).toContain("worker_npm_script deploy");
    expect(hostctl).toContain("billing-config)");
    expect(hostctl).toContain("api GET /api/admin/billing-configuration");
  });
});
