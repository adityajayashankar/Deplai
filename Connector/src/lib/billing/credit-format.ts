/**
 * Credit balances are stored in micro-credit units for accurate accounting,
 * but product surfaces intentionally show monetary-style precision.
 */
export function formatCreditAmount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const normalized = Math.abs(value) < 0.000_001 ? 0 : value;
  return normalized.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
