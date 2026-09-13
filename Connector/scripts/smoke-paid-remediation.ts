import { loadEnvConfig } from '@next/env';
import { randomUUID } from 'node:crypto';
async function main() {
  loadEnvConfig(process.cwd());
  const [user, organization] = process.argv.slice(2);
  if (!user || !organization) throw new Error('Supply authorized user and organization IDs');
  const { registerSecurityBudget } = await import('../src/lib/ai-platform/security-run-budget');
  const id = `paid-smoke-${randomUUID()}`;
  await registerSecurityBudget(id, user, true, organization, 0.01, 'z-ai/glm-5.3-flash');
  const response = await fetch('http://localhost:3000/api/ai/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      'x-api-key': process.env.DEPLAI_SERVICE_KEY || '', 'x-deplai-user-id': user, 'x-deplai-organization-id': organization },
    body: JSON.stringify({ model: 'z-ai/glm-5.3-flash', access_mode: 'platform', max_tokens: 512,
      messages: [{role:'user',content:'Reply OK.'}], metadata: {product:'security',stage:'remediation',remediation_run_id:id} }),
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  console.log(JSON.stringify({status:response.status, model:result.model, code:result.code,
    hasOutput:Boolean(result.output), usage:result.usage, cost:result.cost}));
  if (!response.ok || !result.output) throw new Error('Smoke request did not return output');
}
main().then(() => process.exit(0)).catch(error => { console.error('Paid smoke failed', {name:error.name,code:error.code}); process.exit(1); });
