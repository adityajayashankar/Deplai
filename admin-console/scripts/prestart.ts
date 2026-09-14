import { loadAdminEnv } from './load-env';
import { getAdminConfig } from '../src/lib/config';
import { runAdminSchema } from './schema.mjs';

async function main() {
  loadAdminEnv();
  getAdminConfig();
  await runAdminSchema(process.env, true);
}
main().catch(() => {
  console.error('Admin startup blocked: verify admin configuration and run npm run migrate against the configured database.');
  process.exitCode = 1;
});
