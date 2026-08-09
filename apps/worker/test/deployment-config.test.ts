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

  it("provides environment-specific migration, deploy, and release commands", () => {
    expect(workerPackage).toContain('"db:migrate:remote:staging"');
    expect(workerPackage).toContain('"deploy:staging"');
    expect(rootDeploy).toContain("--environment production|staging");
    expect(rootDeploy).toContain("worker_npm_script db:migrate:remote");
    expect(rootDeploy).toContain("worker_npm_script deploy");
  });
});
