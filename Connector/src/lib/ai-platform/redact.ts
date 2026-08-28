const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_\-]{12,}/g,
  /sk-ant-[A-Za-z0-9_\-]{12,}/g,
  /sk-or-v1-[A-Za-z0-9_\-]{12,}/g,
  /gsk_[A-Za-z0-9_\-]{12,}/g,
  /AIza[A-Za-z0-9_\-]{12,}/g,
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
];

export function redactSecrets(value: string): string {
  let next = value;
  for (const pattern of SECRET_PATTERNS) {
    next = next.replace(pattern, '[redacted]');
  }
  return next;
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
      if (/key|secret|token|authorization|password/i.test(key)) {
        return [key, '[redacted]'];
      }
      return [key, redactUnknown(nested)];
    });
    return Object.fromEntries(entries);
  }
  return value;
}
