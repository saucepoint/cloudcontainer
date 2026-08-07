import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/http.js";

describe("CLI API client", () => {
  it("supports JSON draft updates and deletion with the session cookie", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    const api = new ApiClient(
      "https://usebench.dev",
      "usebench_session=test",
      fetcher as unknown as typeof fetch,
    );

    await api.put("/api/setup-draft", { step: "agents", agents: ["claude"] });
    await api.delete("/api/setup-draft");

    const calls = fetcher.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toBe("https://usebench.dev/api/setup-draft");
    expect(calls[0]?.[1]?.method).toBe("PUT");
    expect(new Headers(calls[0]?.[1]?.headers).get("content-type")).toBe("application/json");
    expect(calls[0]?.[1]?.body).toBe(JSON.stringify({ step: "agents", agents: ["claude"] }));
    expect(new Headers(calls[0]?.[1]?.headers).get("cookie")).toBe("usebench_session=test");
    expect(calls[1]?.[1]?.method).toBe("DELETE");
  });
});
