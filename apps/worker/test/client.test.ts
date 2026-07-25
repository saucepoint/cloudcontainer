import { afterEach, describe, expect, it, vi } from "vitest";
import { pollDelay, type ContainerView } from "../client/dashboard-model.js";
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
    ramMb: 2048,
    diskGb: 8,
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

  it("preserves an API error message and HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "sign in" }, { status: 401 })));

    const error = await requestJson("/api/example").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ message: "sign in", status: 401 });
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

describe("dashboard polling policy", () => {
  it("polls waitlisted environments slowly and active operations quickly", () => {
    expect(pollDelay(container({ status: "waitlisted" }))).toBe(30_000);
    expect(pollDelay(container({ status: "provisioning" }))).toBe(5_000);
    expect(pollDelay(container({
      job: { id: "job-1", op: "sync-keys", status: "running", error: null },
    }))).toBe(5_000);
  });

  it("stops in steady state unless an immediate refresh is required", () => {
    expect(pollDelay(container())).toBeNull();
    expect(pollDelay(container(), true)).toBe(5_000);
  });
});
