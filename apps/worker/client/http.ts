export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

type ErrorFallback = string | ((status: number) => string);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function responseError(value: unknown): string | null {
  return isRecord(value) && typeof value.error === "string" ? value.error : null;
}

function responseCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.code === "string" && /^[a-z0-9_]{1,64}$/.test(value.code)
    ? value.code
    : undefined;
}

export async function requestJson<T>(
  path: string,
  init?: RequestInit,
  fallback: ErrorFallback = (status) => `request failed: ${status}`,
): Promise<T> {
  const response = await fetch(path, init);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const fallbackMessage = typeof fallback === "function" ? fallback(response.status) : fallback;
    throw new HttpError(responseError(payload) ?? fallbackMessage, response.status, responseCode(payload));
  }
  return payload as T;
}

export function postJson<T>(
  path: string,
  body?: object,
  fallback?: ErrorFallback,
): Promise<T> {
  return requestJson<T>(
    path,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    fallback,
  );
}

export function errorMessage(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof HttpError && error.status === 401;
}
