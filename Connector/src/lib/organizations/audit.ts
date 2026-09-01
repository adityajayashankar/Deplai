const SENSITIVE_KEY = /(secret|token|password|credential|private[_-]?key|authorization|cookie|razorpay|aws_access|api[_-]?key)/i;

export function sanitizeAuditMetadata(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => sanitizeAuditMetadata(entry, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') return value.slice(0, 500);
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .slice(0, 50)
      .map(([key, entry]) => [key, sanitizeAuditMetadata(entry, depth + 1)]),
  );
}
