import { describe, expect, it } from "vitest";
import { allowedUserOps, canTransition, pendingStatusFor, successStatusFor } from "../src/state.js";
import { CONTAINER_STATUSES } from "@codestation/contract";

describe("container state machine", () => {
  it("accepts the documented happy path", () => {
    expect(canTransition("waitlisted", "provisioning")).toBe(true);
    expect(canTransition("provisioning", "running")).toBe(true);
    expect(canTransition("running", "stopped")).toBe(true);
    expect(canTransition("stopped", "running")).toBe(true);
    expect(canTransition("running", "suspended")).toBe(true);
    expect(canTransition("suspended", "destroying")).toBe(true);
    expect(canTransition("provisioning", "error")).toBe(true);
    expect(canTransition("error", "provisioning")).toBe(true);
  });

  it("rejects illegal transitions", () => {
    expect(canTransition("waitlisted", "running")).toBe(false);
    expect(canTransition("destroying", "running")).toBe(false);
    expect(canTransition("stopped", "waitlisted")).toBe(false);
    expect(canTransition("suspended", "stopped")).toBe(false);
  });

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

  it("never lets a user act while provisioning or destroying", () => {
    expect(allowedUserOps("provisioning")).toEqual([]);
    expect(allowedUserOps("destroying")).toEqual([]);
  });
});
