export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { loadAdminEnv } = await import('./src/lib/load-env');
  const { resetDbPool } = await import('./src/lib/db');
  loadAdminEnv();
  await resetDbPool();
}
