export const DATASTORE_TCP_PORTS = new Set([5432, 3306, 6379, 27017, 1433, 1521]);

export function coerceHttpAppPort(value: unknown, fallback = 3000): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const port = Math.round(parsed);
  if (port < 1 || port > 65535 || DATASTORE_TCP_PORTS.has(port)) return fallback;
  return port;
}
