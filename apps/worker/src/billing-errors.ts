export class BillingEventError extends Error {
  constructor(readonly code: string) {
    super(`Billing event failed (${code})`);
    this.name = "BillingEventError";
  }
}
