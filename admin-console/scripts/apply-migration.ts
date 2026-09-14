import { runAdminSchema } from './schema.mjs';
import { loadAdminEnv } from './load-env';

async function main() {
  loadAdminEnv();
  await runAdminSchema(process.env, process.argv.includes('--check'));
}

main().catch((error) => {
  console.error('Admin migration failed:', error.code || 'SCHEMA_ERROR');
  console.error('Check database connectivity, DDL privileges and platform prerequisite tables. Rerun npm run migrate after resolving the failure.');
  process.exit(1);
});
