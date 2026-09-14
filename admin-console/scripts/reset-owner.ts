import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { randomBytes } from 'node:crypto';
import { loadAdminEnv } from './load-env';
import { generateTotpSecret } from '../src/lib/auth/totp';
import { validatePasswordStrength } from '../src/lib/auth/password';
import { bootstrapOwner, resetOwnerAccounts } from '../src/lib/admin/accounts';
import { printTotpEnrollment } from './print-totp-enrollment';

function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => randomBytes(5).toString('hex').toUpperCase());
}

async function promptHidden(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

async function main() {
  loadAdminEnv();
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The development reset command is disabled in production. Use an explicitly reviewed owner recovery procedure.');
  }

  const removed = await resetOwnerAccounts();
  if (removed > 0) {
    console.log(`Removed ${removed} existing OWNER account(s).`);
  }

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
  const account = await bootstrapOwner({
    email,
    password,
    totpSecret,
    recoveryCodes,
  });
  if (!account) throw new Error('An OWNER already exists; no replacement credentials were generated.');

  console.log('\nOWNER account recreated successfully.');
  console.log(`Admin ID: ${account.id}`);
  console.log(`Email: ${account.email}`);
  await printTotpEnrollment(account.email, totpSecret);
  console.log('\nRecovery codes (each can be used once):');
  for (const code of recoveryCodes) console.log(`  ${code}`);
  console.log('\nRestart the dev server if it is already running, then sign in at http://127.0.0.1:3100/login');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
