import QRCode from 'qrcode';
import { buildTotpUri } from '../src/lib/auth/totp';

export async function printTotpEnrollment(email: string, totpSecret: string): Promise<void> {
  const uri = buildTotpUri(email, totpSecret);
  console.log('\nGoogle Authenticator setup');
  console.log('1. Open Google Authenticator → Add account → Enter a setup key');
  console.log('2. Account name: Deplai Owner Console');
  console.log('3. Paste this Base32 key (no spaces):');
  console.log(`\n   ${totpSecret}\n`);
  console.log('Or scan this QR code in the terminal:\n');
  console.log(await QRCode.toString(uri, { type: 'terminal', small: true }));
  console.log('\nSetup URI (for other authenticator apps):');
  console.log(uri);
}
