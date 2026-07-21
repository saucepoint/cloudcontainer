export function webAuthnErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (error.name === "NotAllowedError") return "The passkey prompt was cancelled or timed out.";
  return error.message || fallback;
}
