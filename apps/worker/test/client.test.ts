import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatRamGb,
  isBusy,
  planAdjustmentLabel,
  pollDelay,
  type ContainerView,
} from "../client/dashboard-model.js";
import { HttpError, postJson, requestJson } from "../client/http.js";

afterEach(() => vi.unstubAllGlobals());

function container(overrides: Partial<ContainerView> = {}): ContainerView {
  return {
    id: "container-1",
    status: "running",
    statusDetail: null,
    agents: ["claude"],
    tier: "free",
    cpu: 1,
    ramMb: 1536,
    diskGb: 5,
    planTransition: null,
    sshCommand: null,
    hostKeyFingerprints: [],
    job: null,
    allowedOps: [],
    ...overrides,
  };
}

describe("browser JSON transport", () => {
  it("returns a successful JSON payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));

    await expect(requestJson<{ ok: boolean }>("/api/example")).resolves.toEqual({ ok: true });
  });

  it("preserves an API error message, status, and safe machine code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: "sign in",
      code: "session_expired",
    }, { status: 401 })));

    const error = await requestJson("/api/example").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ message: "sign in", status: 401, code: "session_expired" });
  });

  it("uses the caller fallback when an error response is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));

    await expect(requestJson("/api/example", undefined, "Temporarily unavailable"))
      .rejects.toMatchObject({ message: "Temporarily unavailable", status: 502 });
  });

  it("supports status-aware endpoint fallbacks through postJson", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));

    await expect(postJson(
      "/auth/example",
      undefined,
      (status) => status === 401 ? "Sign-in failed." : "Could not complete that request.",
    )).rejects.toMatchObject({ message: "Sign-in failed.", status: 401 });
  });
});

describe("dashboard resource display", () => {
  it("shows the free-tier memory without rounding it up", () => {
    expect(formatRamGb(1536)).toBe("1.5");
    expect(formatRamGb(4096)).toBe("4");
  });
});

describe("dashboard polling policy", () => {
  it("polls waitlisted environments slowly and active operations quickly", () => {
    expect(pollDelay(container({ status: "waitlisted" }))).toBe(30_000);
    expect(pollDelay(container({ status: "provisioning" }))).toBe(5_000);
    expect(pollDelay(container({ status: "upgrade_pending" }))).toBe(5_000);
    expect(pollDelay(container({
      job: { id: "job-1", op: "sync-keys", status: "running", error: null },
    }))).toBe(5_000);
  });

  it("stops in steady state unless an immediate refresh is required", () => {
    expect(pollDelay(container())).toBeNull();
    expect(pollDelay(container(), true)).toBe(5_000);
  });
});

describe("plan adjustment progress", () => {
  it("keeps plan transitions visibly busy while waiting for asynchronous work", () => {
    const pending = container({
      status: "upgrade_pending",
      planTransition: { desiredTier: "paid", state: "waiting_capacity", requestedAt: 1 },
    });

    expect(isBusy(pending)).toBe(true);
    expect(planAdjustmentLabel(pending)).toBe("Waiting for Premium capacity…");
  });

  it("distinguishes a safe downgrade stop from its resource adjustment", () => {
    const transition = { desiredTier: "free", state: "requested", requestedAt: 1 };
    expect(planAdjustmentLabel(container({
      status: "upgrade_pending",
      planTransition: transition,
      job: { id: "job-stop", op: "stop", status: "running", error: null },
    }))).toBe("Stopping your workbench before applying Free limits…");
    expect(planAdjustmentLabel(container({
      status: "upgrade_pending",
      planTransition: { ...transition, state: "resizing" },
    }))).toBe("Applying Free CPU and memory limits…");
  });

  it("shows when an in-place Premium resize is actively applying", () => {
    expect(planAdjustmentLabel(container({
      status: "upgrade_pending",
      planTransition: { desiredTier: "paid", state: "resizing", requestedAt: 1 },
      job: { id: "job-resize", op: "resize", status: "queued", error: null },
    }))).toBe("Applying Premium CPU, memory, and storage limits…");
  });
});
