export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { installAgenticUpgradeProxy } = await import('@/lib/agentic-upgrade-proxy');
  installAgenticUpgradeProxy();
}
