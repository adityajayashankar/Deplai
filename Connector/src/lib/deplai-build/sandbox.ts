import { assertScope, type BuildScope } from './contracts';

export const QUOTA_MAX = {
  cpu: 8, memory_mb: 16384, disk_mb: 32768, pids: 512,
  execution_seconds: 3600, idle_seconds: 3600, lifetime_seconds: 14400,
  agent_sessions: 8, browser_sessions: 2, model_tokens: 1000000, tool_calls: 2000, repair_loops: 5,
} as const;
export type QuotaProfile = { [K in keyof typeof QUOTA_MAX]: number };
export const DEFAULT_QUOTA = Object.freeze({ cpu: 2, memory_mb: 2048, disk_mb: 4096, pids: 128, execution_seconds: 300, idle_seconds: 900, lifetime_seconds: 3600, agent_sessions: 1, browser_sessions: 1, model_tokens: 100000, tool_calls: 100, repair_loops: 1 });
export function validateQuota(input: QuotaProfile): QuotaProfile {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !Object.hasOwn(QUOTA_MAX, key))) throw new Error('Invalid quota profile');
  for (const key of Object.keys(QUOTA_MAX) as (keyof QuotaProfile)[]) {
    const value = input[key];
    if (!Number.isFinite(value) || value <= 0 || value > QUOTA_MAX[key] || (key !== 'cpu' && !Number.isInteger(value))) throw new Error(`Invalid quota: ${key}`);
  }
  if (input.idle_seconds > input.lifetime_seconds || input.execution_seconds > input.lifetime_seconds) throw new Error('Timeout exceeds sandbox lifetime');
  return { ...input };
}

export type SandboxProviderId = 'local-docker' | 'gvisor' | 'firecracker';
export type SandboxPolicy = {
  provider: SandboxProviderId;
  environment: 'development' | 'production';
  trusted_development: boolean;
  quota: QuotaProfile;
  network: { public_egress: 'deny' | 'policy-proxy'; host: false; metadata: false; private_networks: false; sibling_previews: false };
  environment_allowlist: readonly string[];
};
export function validateSandboxPolicy(policy: SandboxPolicy): void {
  if (!policy || !['development', 'production'].includes(policy.environment)) throw new Error('Invalid sandbox environment');
  if (!['local-docker', 'gvisor', 'firecracker'].includes(policy.provider)) throw new Error('Unknown sandbox provider');
  if (policy.provider === 'firecracker') throw new Error('Firecracker is not implemented');
  if (policy.provider === 'local-docker' && (policy.environment !== 'development' || policy.trusted_development !== true)) throw new Error('Local Docker is restricted to trusted development');
  validateQuota(policy.quota);
  const network = policy.network;
  if (!network || !['deny', 'policy-proxy'].includes(network.public_egress) || network.host !== false || network.metadata !== false || network.private_networks !== false || network.sibling_previews !== false) throw new Error('Unsafe sandbox network policy');
  if (!Array.isArray(policy.environment_allowlist) || policy.environment_allowlist.some(key => !/^APP_[A-Z0-9_]+$/.test(key))) throw new Error('Only explicit APP_ environment names are supported in this phase');
}

/** Explicit application values only: never accepts or reads process.env. Secrets arrive in Phase 1.5. */
export function sandboxEnvironment(policy: SandboxPolicy, applicationValues: Record<string, string> = {}): Record<string, string> {
  validateSandboxPolicy(policy);
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(applicationValues)) {
    if (!policy.environment_allowlist.includes(key) || typeof value !== 'string' || value.includes('\0') || value.length > 8192) throw new Error('Invalid sandbox environment input');
    result[key] = value;
  }
  return result;
}

export type SandboxRequest = { scope: BuildScope; policy: SandboxPolicy; revision: string };
export interface SandboxProvider {
  readonly id: SandboxProviderId;
  provision(request: SandboxRequest): Promise<never>;
}
/** Contract only. No Docker/socket/shell imports and no runtime adapter can run code. */
export function sandboxProvider(id: SandboxProviderId): SandboxProvider {
  if (!['local-docker', 'gvisor', 'firecracker'].includes(id)) throw new Error('Unknown sandbox provider');
  return { id, async provision(request) {
    assertScope(request.scope);
    validateSandboxPolicy(request.policy);
    if (request.policy.provider !== id) throw new Error('Sandbox provider mismatch');
    throw new Error('Sandbox execution is disabled until isolation proof and preview phases pass');
  } };
}
