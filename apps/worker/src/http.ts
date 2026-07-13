/** Parse a JSON request body, returning null instead of leaking a syntax error to route handlers. */
export async function readJsonBody<T>(context: {
  req: { json(): Promise<unknown> };
}): Promise<T | null> {
  return (await context.req.json().catch(() => null)) as T | null;
}
