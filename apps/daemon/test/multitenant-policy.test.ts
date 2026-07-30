import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const configurePolicy = readFileSync(
  new URL("../../../infra/configure-multitenant.sh", import.meta.url),
  "utf8",
);

const auditPolicy = readFileSync(
  new URL("../../../infra/audit-multitenant.sh", import.meta.url),
  "utf8",
);

describe("restricted tenant project policy", () => {
  it("allows the daemon-managed swap limit required by the free tier", () => {
    expect(configurePolicy).toContain(
      'incus project set "$PROJECT_NAME" restricted.containers.lowlevel=allow',
    );
    expect(auditPolicy).toContain(
      'check_eq "tenant project allows low-level config for managed swap" "allow"',
    );
  });
});
