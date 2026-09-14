import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { randomBytes } from 'node:crypto';
import { loadAdminEnv } from './load-env';
import { generateTotpSecret } from '../src/lib/auth/totp';
import { validatePasswordStrength } from '../src/lib/auth/password';
import { bootstrapOwner, countOwners } from '../src/lib/admin/accounts';
import { resetDbPool } from '../src/lib/db';
import { getAdminConfig } from '../src/lib/config';
import { printTotpEnrollment } from './print-totp-enrollment';

function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => randomBytes(5).toString('hex').toUpperCase());
}

async function promptHidden(question: string): Promise<string> {
  output.write(question);
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\u0003' || char === '\r' || char === '\n') {
            input.removeListener('data', onData);
            if (char === '\u0003') reject(new Error('Bootstrap cancelled'));
            else resolve(value);
            return;
          }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
          else if (char >= ' ') value += char;
        }
      };
      input.on('data', onData);
    });
  } finally {
    input.setRawMode(false);
    input.pause();
    output.write('\n');
  }
}

async function main() {
  loadAdminEnv();
  getAdminConfig();
  if (await countOwners() > 0) {
    console.log('OWNER already exists; credentials and MFA unchanged.');
    return;
  }
  if (!input.isTTY || !output.isTTY) throw new Error('Bootstrap requires a private interactive terminal (docker compose run --rm).');
  const rl = createInterface({ input, output });
  const email = (await rl.question('Owner email: ')).trim().toLowerCase();
  rl.close();

  const password = await promptHidden('Owner password: ');
  const confirm = await promptHidden('Confirm password: ');
  if (password !== confirm) throw new Error('Passwords do not match');
  const strengthError = validatePasswordStrength(password);
  if (strengthError) throw new Error(strengthError);

  const totpSecret = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes();
  const account = await bootstrapOwner({ email, password, totpSecret, recoveryCodes });
  if (!account) {
    console.log('OWNER already exists; credentials and MFA unchanged.');
    return;
  }

  console.log('\nOWNER account created successfully.');
  console.log(`Admin ID: ${account.id}`);
  console.log(`Email: ${account.email}`);
  await printTotpEnrollment(account.email, totpSecret);
  console.log('\nRecovery codes (each can be used once):');
  for (const code of recoveryCodes) console.log(`  ${code}`);
  console.log('\nThere is no public registration endpoint. Keep these credentials offline.');
}

main().finally(resetDbPool).catch((error) => {
  console.error(error?.code ? 'Owner bootstrap database operation failed; check schema and database access.' : error instanceof Error ? error.message : 'Owner bootstrap failed');
  process.exit(1);
});
