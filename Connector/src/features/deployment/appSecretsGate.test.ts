/**
 * Pure helpers for App Secrets deploy gating (no secret values).
 * Run with: npx --yes tsx Connector/src/features/deployment/appSecretsGate.test.ts
 */

import { parseEnvSecretBlock } from './parseEnvSecretBlock';

export type SecretMeta = { key: string; is_set: boolean; required?: boolean };

export function missingRequiredSecrets(meta: SecretMeta[]): string[] {
  return meta.filter((row) => row.required && !row.is_set).map((row) => row.key);
}

export function deployBlockedBySecrets(_meta: SecretMeta[]): boolean {
  // App secrets are optional — a static blog / CloudFront deploy must never be gated.
  return false;
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  assert(
    !deployBlockedBySecrets([
      { key: 'GOOGLE_CLIENT_ID', required: true, is_set: false },
      { key: 'OPTIONAL_KEY', required: false, is_set: false },
    ]),
    'unset suggested keys must not block deploy',
  );
  assert(
    !deployBlockedBySecrets([
      { key: 'GOOGLE_CLIENT_ID', required: true, is_set: true },
      { key: 'OPTIONAL_KEY', required: false, is_set: false },
    ]),
    'set required keys must not block deploy',
  );
  assert(
    missingRequiredSecrets([{ key: 'A', required: true, is_set: false }]).join(',') === 'A',
    'missing list should include A',
  );

  const parsed = parseEnvSecretBlock(`
# comment
export GOOGLE_CLIENT_ID="abc"
GOOGLE_CLIENT_SECRET=def ghi
EMPTY=
bad-key=1
NEXTAUTH_SECRET='xyz'
`);
  assert(parsed.pairs.length === 3, `expected 3 pairs, got ${parsed.pairs.length}`);
  assert(parsed.pairs.find((p) => p.key === 'GOOGLE_CLIENT_ID')?.value === 'abc', 'quoted google id');
  assert(parsed.pairs.find((p) => p.key === 'GOOGLE_CLIENT_SECRET')?.value === 'def ghi', 'unquoted secret');
  assert(parsed.pairs.find((p) => p.key === 'NEXTAUTH_SECRET')?.value === 'xyz', 'single-quoted secret');

  // eslint-disable-next-line no-console
  console.log('appSecretsGate tests passed');
}

run();
