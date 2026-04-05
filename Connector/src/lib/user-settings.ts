export type SettingsLLMProvider = 'claude' | 'openai' | 'gemini' | 'groq' | 'openrouter';

export interface UserSettingsData {
  integrations: {
    githubAppActive: boolean;
    githubAppId: string;
    githubPrivateKey: string;
    webhookSecret: string;
  };
  cloud: {
    defaultRegion: string;
    monthlyBudgetUsd: number;
    budgetOverride: boolean;
    awsAccessKeyId: string;
    awsSecretAccessKey: string;
  };
  ai: {
    provider: SettingsLLMProvider;
    model: string;
    apiKey: string;
    maxExecutionCycles: number;
    autoApproveLow: boolean;
  };
  workspace: {
    serviceKey: string;
    sessionSecret: string;
    wsTokenSecret: string;
  };
}

export interface PublicUserSettings {
  integrations: {
    githubAppActive: boolean;
    githubAppId: string;
    hasGithubPrivateKey: boolean;
    hasWebhookSecret: boolean;
  };
  cloud: {
    defaultRegion: string;
    monthlyBudgetUsd: number;
    budgetOverride: boolean;
    hasAwsAccessKeyId: boolean;
    hasAwsSecretAccessKey: boolean;
  };
  ai: {
    provider: SettingsLLMProvider;
    model: string;
    hasApiKey: boolean;
    maxExecutionCycles: number;
    autoApproveLow: boolean;
  };
  workspace: {
    hasServiceKey: boolean;
    hasSessionSecret: boolean;
    hasWsTokenSecret: boolean;
  };
}

export const DEFAULT_USER_SETTINGS: UserSettingsData = {
  integrations: {
    githubAppActive: true,
    githubAppId: '',
    githubPrivateKey: '',
    webhookSecret: '',
  },
  cloud: {
    defaultRegion: 'us-east-1',
    monthlyBudgetUsd: 100,
    budgetOverride: false,
    awsAccessKeyId: '',
    awsSecretAccessKey: '',
  },
  ai: {
    provider: 'claude',
    model: 'claude-opus-4-5',
    apiKey: '',
    maxExecutionCycles: 2,
    autoApproveLow: false,
  },
  workspace: {
    serviceKey: '',
    sessionSecret: '',
    wsTokenSecret: '',
  },
};

const VALID_PROVIDERS = new Set<SettingsLLMProvider>(['claude', 'openai', 'gemini', 'groq', 'openrouter']);

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeString(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.slice(0, maxLength);
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function normalizeProvider(value: unknown, fallback: SettingsLLMProvider): SettingsLLMProvider {
  if (typeof value !== 'string') return fallback;
  const lowered = value.trim().toLowerCase() as SettingsLLMProvider;
  return VALID_PROVIDERS.has(lowered) ? lowered : fallback;
}

function normalizeSecretPatch(current: string, value: unknown): string {
  if (value === undefined) return current;
  if (value === null) return '';
  if (typeof value !== 'string') return current;
  const trimmed = value.trim();
  if (!trimmed) return current;
  return trimmed.slice(0, 8192);
}

export function cloneDefaultUserSettings(): UserSettingsData {
  return JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS)) as UserSettingsData;
}

export function parseStoredUserSettings(input: unknown): UserSettingsData {
  const base = cloneDefaultUserSettings();
  const root = asObject(input);
  const integrations = asObject(root.integrations);
  const cloud = asObject(root.cloud);
  const ai = asObject(root.ai);
  const workspace = asObject(root.workspace);

  base.integrations.githubAppActive = normalizeBoolean(integrations.githubAppActive, base.integrations.githubAppActive);
  base.integrations.githubAppId = normalizeString(integrations.githubAppId, base.integrations.githubAppId, 128);
  base.integrations.githubPrivateKey = normalizeString(integrations.githubPrivateKey, base.integrations.githubPrivateKey, 8192);
  base.integrations.webhookSecret = normalizeString(integrations.webhookSecret, base.integrations.webhookSecret, 2048);

  base.cloud.defaultRegion = normalizeString(cloud.defaultRegion, base.cloud.defaultRegion, 64);
  base.cloud.monthlyBudgetUsd = normalizeNumber(cloud.monthlyBudgetUsd, base.cloud.monthlyBudgetUsd, 1, 100000);
  base.cloud.budgetOverride = normalizeBoolean(cloud.budgetOverride, base.cloud.budgetOverride);
  base.cloud.awsAccessKeyId = normalizeString(cloud.awsAccessKeyId, base.cloud.awsAccessKeyId, 256);
  base.cloud.awsSecretAccessKey = normalizeString(cloud.awsSecretAccessKey, base.cloud.awsSecretAccessKey, 2048);

  base.ai.provider = normalizeProvider(ai.provider, base.ai.provider);
  base.ai.model = normalizeString(ai.model, base.ai.model, 128);
  base.ai.apiKey = normalizeString(ai.apiKey, base.ai.apiKey, 2048);
  base.ai.maxExecutionCycles = Math.round(normalizeNumber(ai.maxExecutionCycles, base.ai.maxExecutionCycles, 1, 5));
  base.ai.autoApproveLow = normalizeBoolean(ai.autoApproveLow, base.ai.autoApproveLow);

  base.workspace.serviceKey = normalizeString(workspace.serviceKey, base.workspace.serviceKey, 2048);
  base.workspace.sessionSecret = normalizeString(workspace.sessionSecret, base.workspace.sessionSecret, 2048);
  base.workspace.wsTokenSecret = normalizeString(workspace.wsTokenSecret, base.workspace.wsTokenSecret, 2048);

  return base;
}

export function mergeUserSettingsPatch(current: UserSettingsData, patchInput: unknown): UserSettingsData {
  const next = parseStoredUserSettings(current);
  const patch = asObject(patchInput);

  const integrationsPatch = asObject(patch.integrations);
  if (Object.prototype.hasOwnProperty.call(integrationsPatch, 'githubAppActive')) {
    next.integrations.githubAppActive = normalizeBoolean(integrationsPatch.githubAppActive, next.integrations.githubAppActive);
  }
  if (Object.prototype.hasOwnProperty.call(integrationsPatch, 'githubAppId')) {
    next.integrations.githubAppId = normalizeString(integrationsPatch.githubAppId, next.integrations.githubAppId, 128);
  }
  next.integrations.githubPrivateKey = normalizeSecretPatch(next.integrations.githubPrivateKey, integrationsPatch.githubPrivateKey);
  next.integrations.webhookSecret = normalizeSecretPatch(next.integrations.webhookSecret, integrationsPatch.webhookSecret);

  const cloudPatch = asObject(patch.cloud);
  if (Object.prototype.hasOwnProperty.call(cloudPatch, 'defaultRegion')) {
    next.cloud.defaultRegion = normalizeString(cloudPatch.defaultRegion, next.cloud.defaultRegion, 64);
  }
  if (Object.prototype.hasOwnProperty.call(cloudPatch, 'monthlyBudgetUsd')) {
    next.cloud.monthlyBudgetUsd = normalizeNumber(cloudPatch.monthlyBudgetUsd, next.cloud.monthlyBudgetUsd, 1, 100000);
  }
  if (Object.prototype.hasOwnProperty.call(cloudPatch, 'budgetOverride')) {
    next.cloud.budgetOverride = normalizeBoolean(cloudPatch.budgetOverride, next.cloud.budgetOverride);
  }
  next.cloud.awsAccessKeyId = normalizeSecretPatch(next.cloud.awsAccessKeyId, cloudPatch.awsAccessKeyId);
  next.cloud.awsSecretAccessKey = normalizeSecretPatch(next.cloud.awsSecretAccessKey, cloudPatch.awsSecretAccessKey);

  const aiPatch = asObject(patch.ai);
  if (Object.prototype.hasOwnProperty.call(aiPatch, 'provider')) {
    next.ai.provider = normalizeProvider(aiPatch.provider, next.ai.provider);
  }
  if (Object.prototype.hasOwnProperty.call(aiPatch, 'model')) {
    next.ai.model = normalizeString(aiPatch.model, next.ai.model, 128);
  }
  if (Object.prototype.hasOwnProperty.call(aiPatch, 'maxExecutionCycles')) {
    next.ai.maxExecutionCycles = Math.round(normalizeNumber(aiPatch.maxExecutionCycles, next.ai.maxExecutionCycles, 1, 5));
  }
  if (Object.prototype.hasOwnProperty.call(aiPatch, 'autoApproveLow')) {
    next.ai.autoApproveLow = normalizeBoolean(aiPatch.autoApproveLow, next.ai.autoApproveLow);
  }
  next.ai.apiKey = normalizeSecretPatch(next.ai.apiKey, aiPatch.apiKey);

  const workspacePatch = asObject(patch.workspace);
  next.workspace.serviceKey = normalizeSecretPatch(next.workspace.serviceKey, workspacePatch.serviceKey);
  next.workspace.sessionSecret = normalizeSecretPatch(next.workspace.sessionSecret, workspacePatch.sessionSecret);
  next.workspace.wsTokenSecret = normalizeSecretPatch(next.workspace.wsTokenSecret, workspacePatch.wsTokenSecret);

  return next;
}

export function toPublicUserSettings(settings: UserSettingsData): PublicUserSettings {
  return {
    integrations: {
      githubAppActive: settings.integrations.githubAppActive,
      githubAppId: settings.integrations.githubAppId,
      hasGithubPrivateKey: settings.integrations.githubPrivateKey.length > 0,
      hasWebhookSecret: settings.integrations.webhookSecret.length > 0,
    },
    cloud: {
      defaultRegion: settings.cloud.defaultRegion,
      monthlyBudgetUsd: settings.cloud.monthlyBudgetUsd,
      budgetOverride: settings.cloud.budgetOverride,
      hasAwsAccessKeyId: settings.cloud.awsAccessKeyId.length > 0,
      hasAwsSecretAccessKey: settings.cloud.awsSecretAccessKey.length > 0,
    },
    ai: {
      provider: settings.ai.provider,
      model: settings.ai.model,
      hasApiKey: settings.ai.apiKey.length > 0,
      maxExecutionCycles: settings.ai.maxExecutionCycles,
      autoApproveLow: settings.ai.autoApproveLow,
    },
    workspace: {
      hasServiceKey: settings.workspace.serviceKey.length > 0,
      hasSessionSecret: settings.workspace.sessionSecret.length > 0,
      hasWsTokenSecret: settings.workspace.wsTokenSecret.length > 0,
    },
  };
}
