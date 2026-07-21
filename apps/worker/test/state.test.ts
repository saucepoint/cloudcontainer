import { describe, expect, it } from "vitest";
import { allowedUserOps, pendingStatusFor, successStatusFor } from "../src/state.js";
import { CONTAINER_STATUSES } from "@workbench/contract";

describe("container lifecycle policy", () => {
  it("keeps suspended and user-stopped distinguishable", () => {
    expect(CONTAINER_STATUSES).toContain("suspended");
    expect(CONTAINER_STATUSES).toContain("stopped");
    expect(allowedUserOps("suspended")).toEqual([]); // user cannot start a suspended box
    expect(allowedUserOps("stopped")).toContain("start");
  });

  it("maps ops to pending and success statuses", () => {
    expect(pendingStatusFor("provision")).toBe("provisioning");
    expect(pendingStatusFor("rebuild")).toBe("provisioning");
    expect(pendingStatusFor("destroy")).toBe("destroying");
    expect(pendingStatusFor("sync-keys")).toBeNull();
    expect(successStatusFor("provision")).toBe("running");
    expect(successStatusFor("stop")).toBe("stopped");
    expect(successStatusFor("refresh-credentials")).toBeNull();
  });

  it("only exposes lifecycle actions, not automatic synchronization jobs", () => {
    expect(allowedUserOps("running")).toEqual(["stop", "rebuild", "destroy"]);
    expect(allowedUserOps("provisioning")).toEqual([]);
    expect(allowedUserOps("destroying")).toEqual([]);
  });
});
