import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configurePolicy = readFileSync(
  new URL("../../../infra/configure-multitenant.sh", import.meta.url),
  "utf8",
);

const auditPolicy = readFileSync(
  new URL("../../../infra/audit-multitenant.sh", import.meta.url),
  "utf8",
);

const hostPolicyUrl = new URL("../../../infra/host-policy.sh", import.meta.url);
const hostPolicyPath = fileURLToPath(hostPolicyUrl);
const hostPolicy = readFileSync(hostPolicyUrl, "utf8");

const bootstrap = readFileSync(
  new URL("../../../infra/bootstrap.sh", import.meta.url),
  "utf8",
);

const hostController = readFileSync(
  new URL("../../../infra/hostctl.sh", import.meta.url),
  "utf8",
);

const capacityReport = readFileSync(
  new URL("../../../infra/report-host-capacity.sh", import.meta.url),
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

  it("uses one tenancy/resource policy for bootstrap, configuration, and audit", () => {
    expect(bootstrap).toContain("/host-policy.sh");
    expect(configurePolicy).toContain("/host-policy.sh");
    expect(auditPolicy).toContain("/host-policy.sh");
    expect(hostPolicy).toContain("budget)");
    expect(hostPolicy).toContain("regular)");
    expect(hostPolicy).toContain("dedicated)");
    expect(configurePolicy).toContain('calculate_host_capacity "$POOL_NAME"');
    expect(auditPolicy).toContain('calculate_host_capacity "$POOL_NAME"');
    expect(configurePolicy).toContain(".storagePool");
    expect(auditPolicy).toContain(".storagePool");
    expect(hostPolicy).toContain('if [[ "$HOST_TYPE" == "dedicated"');
    expect(hostPolicy).toContain("TENANT_SLOTS=1");
    expect(hostPolicy).toContain("IDMAP_SLOTS");
    expect(hostPolicy).toContain("unsupported policy entry");
    expect(hostPolicy).toContain("TENANCY_MODE");
    expect(bootstrap).toContain("tenancyMode: $tenancyMode");
    expect(hostController).toContain(".tenancyMode = $tenancy_mode");
  });

  it("keeps per-container CPU enforcement equal to its persisted tier", () => {
    expect(hostPolicy).toContain("TENANT_ADVERTISED_CPU=1");
    expect(hostPolicy).toContain("TENANT_ADVERTISED_CPU=2");
    expect(hostPolicy).toContain("TENANT_CPU=1");
    expect(hostPolicy).toContain("TENANT_CPU=2");
    expect(configurePolicy).toContain('limits.cpu="$INSTANCE_CPU"');
    expect(configurePolicy).toContain("limits.memory.enforce=hard");
    expect(auditPolicy).toContain('"$INSTANCE_CPU"');
    expect(configurePolicy).toContain("INSTANCE_TIER");
    expect(auditPolicy).toContain("INSTANCE_TIER");
  });

  it("preserves mixed tiers and grandfathered disk during a fleet policy release", () => {
    expect(configurePolicy).toContain('if [[ "$TENANCY_MODE" == "dedicated"');
    expect(configurePolicy).toContain('free)');
    expect(configurePolicy).toContain('paid)');
    expect(configurePolicy).not.toContain('host classes cannot be mixed');
    expect(configurePolicy).not.toContain("storage volume set");
    expect(auditPolicy).toContain('"5GiB" || "$actual" == "8GiB"');
    expect(configurePolicy).toContain("INSTANCE_SWAP_MB=1536");
    expect(auditPolicy).toContain("INSTANCE_SWAP_MB=1536");
    expect(hostPolicy).toContain("TENANT_SWAP_MB=1536");
    expect(hostPolicy).toContain("SLOT_SWAP_MB=1536");
  });

  it("rounds up 4x CPU and 1.25x RAM tenant ceilings", () => {
    const values = execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
source "$1"
printf '%s %s %s %s %s\n' \
  "$(minimum_host_ram_reserve_mb 8192)" \
  "$(minimum_host_ram_reserve_mb 38401)" \
  "$(minimum_host_ram_reserve_mb 65536)" \
  "$VCPU_OVERCOMMIT" \
  "$MAX_VCPU_OVERCOMMIT"`,
        "host-policy-test",
        hostPolicyPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DISK_CAPACITY_PERCENT: "70",
          HOST_RAM_RESERVE_MB: "0",
          HOST_TYPE: "budget",
          VCPU_OVERCOMMIT: "4",
          WORKBENCH_HOST_POLICY_ENV: "/nonexistent/workbench-host-policy.env",
        },
      },
    ).trim();

    expect(values).toBe("3072 3073 5243 4 4");
    expect(hostPolicy).toContain("HOST_VCPU_COUNT=$(nproc)");
    expect(hostPolicy).toContain("VCPU_CAPACITY=$(( HOST_VCPU_COUNT * VCPU_OVERCOMMIT ))");
    expect(hostPolicy).toContain("HOST_RAM_OVERCOMMIT_NUMERATOR=5");
    expect(hostPolicy).toContain("HOST_RAM_OVERCOMMIT_DENOMINATOR=4");
    expect(hostPolicy).toContain("CPU_SLOTS=$(( (VCPU_CAPACITY + TENANT_CPU - 1) / TENANT_CPU ))");
    expect(hostController).toContain("MAX_VCPU_OVERCOMMIT=4");
    expect(hostController).toContain("Reservations per online host vCPU (default/max: 4)");
  });

  it("supports static capacity partitions for shared production and staging hosts", () => {
    expect(hostPolicy).toContain("HOST_TENANT_LIMIT");
    expect(hostPolicy).toContain("RESOURCE_TENANT_SLOTS");
    expect(configurePolicy).toContain("SHARED_CAPACITY_PROJECT");
    expect(configurePolicy).toContain("shared project tenant caps exceed physical capacity");
    expect(configurePolicy).toContain("incus project show workbench-staging");
    expect(configurePolicy).toContain("features.storage.volumes=true </dev/null");
    expect(bootstrap).toContain("SHARED_PHYSICAL_HOST");
    expect(bootstrap).toContain("workbench-staging");
    expect(bootstrap).toContain("workbench-daemon@staging");
    expect(hostController).toContain("WORKBENCH_ENVIRONMENT");
    expect(hostController).toContain("--tenant-limit");
    expect(hostController).toContain("--daemon-port");
    // SSH flattens remote command arguments, so an empty production peer must
    // use a sentinel instead of shifting every following positional argument.
    expect(hostController).toContain('"${SHARED_CAPACITY_PROJECT:--}"');
    expect(hostController).toContain('if [[ "$shared_capacity_project" == - ]]');
    expect(hostController).toContain('WB_DAEMON_CONFIG="$config_dir/daemon.json"');
    expect(hostController).toContain('DAEMON_SERVICE="$daemon_service"');
  });

  it("checks local capacity and image availability before a host can return to service", () => {
    expect(auditPolicy).toContain("EXPECTED_MAX_TENANTS");
    expect(auditPolicy).toContain("calculated tenant ceiling covers the D1 registration");
    expect(auditPolicy).toContain('image info "$BASE_IMAGE"');
    expect(capacityReport).toContain('calculate_host_capacity "$POOL_NAME"');
    expect(hostController).toContain("refresh_host_capacity");
    expect(hostController).toContain("'{capacity: $capacity}'");
    expect(configurePolicy).toContain('limits.cpu="$CPU_LIMIT"');
    expect(configurePolicy).toContain('limits.memory="${RAM_LIMIT_MB}MiB"');
    expect(auditPolicy).toContain('"$CPU_LIMIT"');
    expect(auditPolicy).toContain('"${RAM_LIMIT_MB}MiB"');
  });

  it("uses project-aware REST URLs for raw Incus audit queries", () => {
    expect(auditPolicy).toContain(
      'incus query "/1.0/instances/${name}?project=${PROJECT_QUERY}&recursion=1"',
    );
    expect(auditPolicy).toContain(
      ".metadata.expanded_devices[$device][$key] // .expanded_devices[$device][$key]",
    );
    expect(auditPolicy).not.toContain('incus --project "$PROJECT_NAME" query');
  });

  it("drains, backs up, probes, and verifies the release before reactivation", () => {
    const drain = hostController.indexOf("Draining $host_id");
    const identity = hostController.indexOf('remote_preflight "$hostname"', drain);
    const backup = hostController.indexOf('remote_backup "$hostname"', identity);
    const install = hostController.indexOf('remote_install "$hostname"', backup);
    const probe = hostController.indexOf('api POST "/api/admin/hosts/$host_id/probe"', install);
    const releaseCheck = hostController.indexOf('[[ "$observed" != "$release" ]]', probe);
    const activate = hostController.indexOf("'{\"status\":\"active\"}'", releaseCheck);
    expect(drain).toBeGreaterThan(-1);
    expect(identity).toBeGreaterThan(drain);
    expect(backup).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(backup);
    expect(probe).toBeGreaterThan(install);
    expect(releaseCheck).toBeGreaterThan(probe);
    expect(activate).toBeGreaterThan(releaseCheck);
  });

  it("stops a host rollout immediately when its isolated deployment fails", () => {
    expect(hostController).toContain(
      '(set -Eeuo pipefail; deploy_one "$host" "$release")',
    );
    expect(hostController).toContain("deployment_status=$?");
    expect(hostController).toContain("if (( deployment_status != 0 )); then");
    expect(hostController).not.toContain(
      'if ! (set -Eeuo pipefail; deploy_one "$host" "$release")',
    );
  });
});
