export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

export function dollarsToCents(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Amount must be a non-negative number.");
  }
  return Math.round(value * 100);
}

export function moneyToPayPal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error("PayPal amounts must be positive integer cents.");
  }
  return (cents / 100).toFixed(2);
}
