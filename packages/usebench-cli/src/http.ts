export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function responseError(value: unknown): string | null {
  return isRecord(value) && typeof value.error === "string" ? value.error : null;
}

export type FetchLike = typeof fetch;

export class ApiClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private cookie: string | null = null,
    private readonly fetcher: FetchLike = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  get sessionCookie(): string | null {
    return this.cookie;
  }

  set sessionCookie(value: string | null) {
    this.cookie = value;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (this.cookie) headers.set("cookie", this.cookie);
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(responseError(payload) ?? `request failed: ${response.status}`, response.status);
    }
    return payload as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method: "POST" };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return this.request<T>(path, init);
  }

  async exchangeSession(code: string): Promise<string> {
    const response = await this.fetcher(`${this.baseUrl}/api/cli/auth/exchange`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(responseError(payload) ?? `sign-in exchange failed: ${response.status}`, response.status);
    }
    const cookies = response.headers.getSetCookie();
    const cookie = cookies[0]?.split(";", 1)[0];
    if (!cookie) throw new Error("The server did not return a CLI session cookie.");
    this.cookie = cookie;
    return cookie;
  }
}

export async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function errorMessage(error: unknown, fallback = "Unexpected request failure"): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
