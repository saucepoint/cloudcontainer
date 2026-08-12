export function formatMonthlyPrice(price: string, currency: string): string {
  const amount = price.trim();
  const code = currency.trim().toUpperCase();
  return code === "USD" ? `$${amount}/mo` : `${code} ${amount}/mo`;
}
