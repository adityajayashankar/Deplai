/** Parse a .env / KEY=VALUE paste block into secret pairs (no React). */

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnvSecretBlock(raw: string): {
  pairs: Array<{ key: string; value: string }>;
  skipped: string[];
} {
  const pairs: Array<{ key: string; value: string }> = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const originalLine of String(raw || '').split(/\r?\n/)) {
    let line = originalLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.toLowerCase().startsWith('export ')) {
      line = line.slice(7).trim();
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      skipped.push(originalLine.trim());
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!ENV_KEY_RE.test(key)) {
      skipped.push(key || originalLine.trim());
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!value) {
      skipped.push(`${key}=`);
      continue;
    }
    if (seen.has(key)) {
      const idx = pairs.findIndex((row) => row.key === key);
      if (idx >= 0) pairs[idx] = { key, value };
      continue;
    }
    seen.add(key);
    pairs.push({ key, value });
  }

  return { pairs, skipped };
}

export function isValidEnvSecretKey(key: string): boolean {
  return ENV_KEY_RE.test(String(key || '').trim());
}
