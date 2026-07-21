import { bodyLimit } from "hono/body-limit";

/**
 * Current JSON inputs top out below 200 KiB even when every credential field
 * is populated. Keep enough headroom for encoding overhead without allowing a
 * request to consume the Worker's full memory limit before validation runs.
 */
const REQUEST_BODY_MAX_BYTES = 256 * 1024;

export const requestBodyLimit = bodyLimit({
  maxSize: REQUEST_BODY_MAX_BYTES,
  onError: (context) => context.json({ error: "request body is too large" }, 413),
});

/** Parse a JSON request body, returning null instead of leaking a syntax error to route handlers. */
export async function readJsonBody<T>(context: {
  req: { json(): Promise<unknown> };
}): Promise<T | null> {
  return (await context.req.json().catch(() => null)) as T | null;
}
