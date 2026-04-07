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
  user: {
    account: {
      avatarInitials: string;
      displayName: string;
      roleTitle: string;
      bio: string;
      contactEmail: string;
      language: string;
      timezone: string;
      dateFormat: string;
      numberFormat: string;
    };
    security: {
      mfaEnabled: boolean;
      recoveryCodes: number;
      passkeys: Array<{
        id: string;
        name: string;
        detail: string;
      }>;
    };
    notifications: {
      events: Array<{
        id: string;
        label: string;
        email: boolean;
        inApp: boolean;
        slack: boolean;
      }>;
      quietHoursEnabled: boolean;
      startTime: string;
      endTime: string;
      timezone: string;
    };
    preferences: {
      theme: 'dark' | 'light' | 'system';
      density: 'comfortable' | 'default' | 'compact';
      fontSize: 'small' | 'default' | 'large';
      reducedMotion: boolean;
      highContrast: boolean;
      keyboardHints: boolean;
    };
    aiDefaults: {
      preferredProvider: SettingsLLMProvider;
      preferredModel: string;
      fallbackModel: string;
      personalApiKey: string;
      personalKeyLabel: string;
      keyLastUsed: string;
    };
    integrations: {
      githubConnected: boolean;
      githubUsername: string;
      personalPat: string;
    };
    privacy: {
      usageTelemetry: boolean;
      analyticsLevel: 'basic' | 'enhanced' | 'full';
      productEmails: boolean;
    };
    billing: {
      deployments: number;
      tokensUsed: number;
      apiCalls: number;
      estimatedCostUsd: number;
    };
    sessions: {
      rows: Array<{
        id: string;
        deviceType: 'laptop' | 'phone';
        name: string;
        location: string;
        time: string;
        current: boolean;
      }>;
    };
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
  user: {
    account: {
      avatarInitials: string;
      displayName: string;
      roleTitle: string;
      bio: string;
      contactEmail: string;
      language: string;
      timezone: string;
      dateFormat: string;
      numberFormat: string;
    };
    security: {
      mfaEnabled: boolean;
      recoveryCodes: number;
      passkeys: Array<{
        id: string;
        name: string;
        detail: string;
      }>;
    };
    notifications: {
      events: Array<{
        id: string;
        label: string;
        email: boolean;
        inApp: boolean;
        slack: boolean;
      }>;
      quietHoursEnabled: boolean;
      startTime: string;
      endTime: string;
      timezone: string;
    };
    preferences: {
      theme: 'dark' | 'light' | 'system';
      density: 'comfortable' | 'default' | 'compact';
      fontSize: 'small' | 'default' | 'large';
      reducedMotion: boolean;
      highContrast: boolean;
      keyboardHints: boolean;
    };
    aiDefaults: {
      preferredProvider: SettingsLLMProvider;
      preferredModel: string;
      fallbackModel: string;
      hasPersonalApiKey: boolean;
      personalKeyLabel: string;
      keyLastUsed: string;
    };
    integrations: {
      githubConnected: boolean;
      githubUsername: string;
      hasPersonalPat: boolean;
    };
    privacy: {
      usageTelemetry: boolean;
      analyticsLevel: 'basic' | 'enhanced' | 'full';
      productEmails: boolean;
    };
    billing: {
      deployments: number;
      tokensUsed: number;
      apiCalls: number;
      estimatedCostUsd: number;
    };
    sessions: {
      rows: Array<{
        id: string;
        deviceType: 'laptop' | 'phone';
        name: string;
        location: string;
        time: string;
        current: boolean;
      }>;
    };
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
  user: {
    account: {
      avatarInitials: 'AJ',
      displayName: 'AJ',
      roleTitle: 'AI Infrastructure Engineer',
      bio: 'Building DeplAI - multi-agent AWS deployment automation.',
      contactEmail: 'aj@pesuventurelabs.com',
      language: 'English (US)',
      timezone: 'Asia/Kolkata (IST)',
      dateFormat: 'DD/MM/YYYY',
      numberFormat: '1,234.56',
    },
    security: {
      mfaEnabled: true,
      recoveryCodes: 8,
      passkeys: [
        {
          id: 'pk-macbook',
          name: 'MacBook Pro',
          detail: 'Chrome - Added 10 days ago - Last used today',
        },
      ],
    },
    notifications: {
      events: [
        { id: 'deploy-started', label: 'Deployment started', email: true, inApp: true, slack: false },
        { id: 'deploy-succeeded', label: 'Deployment succeeded', email: true, inApp: true, slack: true },
        { id: 'deploy-failed', label: 'Deployment failed', email: true, inApp: true, slack: true },
        { id: 'remediation-completed', label: 'Remediation completed', email: false, inApp: true, slack: false },
        { id: 'remediation-approval', label: 'Remediation requires approval', email: true, inApp: true, slack: true },
        { id: 'budget-warning', label: 'Budget warning threshold hit', email: true, inApp: true, slack: true },
        { id: 'security-finding', label: 'Security finding detected', email: true, inApp: true, slack: false },
      ],
      quietHoursEnabled: true,
      startTime: '22:00',
      endTime: '08:00',
      timezone: 'IST',
    },
    preferences: {
      theme: 'dark',
      density: 'default',
      fontSize: 'default',
      reducedMotion: false,
      highContrast: false,
      keyboardHints: false,
    },
    aiDefaults: {
      preferredProvider: 'claude',
      preferredModel: 'claude-opus-4-5',
      fallbackModel: 'gpt-4o',
      personalApiKey: '',
      personalKeyLabel: 'personal-key',
      keyLastUsed: 'Never',
    },
    integrations: {
      githubConnected: true,
      githubUsername: 'aj-dev',
      personalPat: '',
    },
    privacy: {
      usageTelemetry: true,
      analyticsLevel: 'basic',
      productEmails: false,
    },
    billing: {
      deployments: 12,
      tokensUsed: 847000,
      apiCalls: 234,
      estimatedCostUsd: 3.21,
    },
    sessions: {
      rows: [
        {
          id: 'sess-macbook',
          deviceType: 'laptop',
          name: 'MacBook Pro - Chrome',
          location: 'Bengaluru, IN',
          time: 'Active now',
          current: true,
        },
        {
          id: 'sess-iphone',
          deviceType: 'phone',
          name: 'iPhone 15 - Safari',
          location: 'Bengaluru, IN',
          time: '2 hours ago',
          current: false,
        },
      ],
    },
  },
};

const VALID_PROVIDERS = new Set<SettingsLLMProvider>(['claude', 'openai', 'gemini', 'groq', 'openrouter']);
const VALID_THEME = new Set<UserSettingsData['user']['preferences']['theme']>(['dark', 'light', 'system']);
const VALID_DENSITY = new Set<UserSettingsData['user']['preferences']['density']>(['comfortable', 'default', 'compact']);
const VALID_FONT_SIZE = new Set<UserSettingsData['user']['preferences']['fontSize']>(['small', 'default', 'large']);
const VALID_ANALYTICS = new Set<UserSettingsData['user']['privacy']['analyticsLevel']>(['basic', 'enhanced', 'full']);
const VALID_DEVICE_TYPES = new Set<UserSettingsData['user']['sessions']['rows'][number]['deviceType']>(['laptop', 'phone']);

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

function normalizeTheme(value: unknown, fallback: UserSettingsData['user']['preferences']['theme']): UserSettingsData['user']['preferences']['theme'] {
  if (typeof value !== 'string') return fallback;
  const lowered = value.trim().toLowerCase() as UserSettingsData['user']['preferences']['theme'];
  return VALID_THEME.has(lowered) ? lowered : fallback;
}

function normalizeDensity(value: unknown, fallback: UserSettingsData['user']['preferences']['density']): UserSettingsData['user']['preferences']['density'] {
  if (typeof value !== 'string') return fallback;
  const lowered = value.trim().toLowerCase() as UserSettingsData['user']['preferences']['density'];
  return VALID_DENSITY.has(lowered) ? lowered : fallback;
}

function normalizeFontSize(value: unknown, fallback: UserSettingsData['user']['preferences']['fontSize']): UserSettingsData['user']['preferences']['fontSize'] {
  if (typeof value !== 'string') return fallback;
  const lowered = value.trim().toLowerCase() as UserSettingsData['user']['preferences']['fontSize'];
  return VALID_FONT_SIZE.has(lowered) ? lowered : fallback;
}

function normalizeAnalyticsLevel(value: unknown, fallback: UserSettingsData['user']['privacy']['analyticsLevel']): UserSettingsData['user']['privacy']['analyticsLevel'] {
  if (typeof value !== 'string') return fallback;
  const lowered = value.trim().toLowerCase() as UserSettingsData['user']['privacy']['analyticsLevel'];
  return VALID_ANALYTICS.has(lowered) ? lowered : fallback;
}

function normalizeDeviceType(
  value: unknown,
  fallback: UserSettingsData['user']['sessions']['rows'][number]['deviceType']
): UserSettingsData['user']['sessions']['rows'][number]['deviceType'] {
  if (typeof value !== 'string') return fallback;
  const lowered = value.trim().toLowerCase() as UserSettingsData['user']['sessions']['rows'][number]['deviceType'];
  return VALID_DEVICE_TYPES.has(lowered) ? lowered : fallback;
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
  const user = asObject(root.user);
  const userAccount = asObject(user.account);
  const userSecurity = asObject(user.security);
  const userNotifications = asObject(user.notifications);
  const userPreferences = asObject(user.preferences);
  const userAiDefaults = asObject(user.aiDefaults);
  const userIntegrations = asObject(user.integrations);
  const userPrivacy = asObject(user.privacy);
  const userBilling = asObject(user.billing);
  const userSessions = asObject(user.sessions);

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

  base.user.account.avatarInitials = normalizeString(userAccount.avatarInitials, base.user.account.avatarInitials, 4).toUpperCase();
  base.user.account.displayName = normalizeString(userAccount.displayName, base.user.account.displayName, 64);
  base.user.account.roleTitle = normalizeString(userAccount.roleTitle, base.user.account.roleTitle, 128);
  base.user.account.bio = normalizeString(userAccount.bio, base.user.account.bio, 512);
  base.user.account.contactEmail = normalizeString(userAccount.contactEmail, base.user.account.contactEmail, 160);
  base.user.account.language = normalizeString(userAccount.language, base.user.account.language, 64);
  base.user.account.timezone = normalizeString(userAccount.timezone, base.user.account.timezone, 64);
  base.user.account.dateFormat = normalizeString(userAccount.dateFormat, base.user.account.dateFormat, 64);
  base.user.account.numberFormat = normalizeString(userAccount.numberFormat, base.user.account.numberFormat, 64);

  base.user.security.mfaEnabled = normalizeBoolean(userSecurity.mfaEnabled, base.user.security.mfaEnabled);
  base.user.security.recoveryCodes = Math.round(normalizeNumber(userSecurity.recoveryCodes, base.user.security.recoveryCodes, 0, 32));
  if (Array.isArray(userSecurity.passkeys)) {
    base.user.security.passkeys = userSecurity.passkeys.map((raw, index) => {
      const item = asObject(raw);
      return {
        id: normalizeString(item.id, `passkey-${index + 1}`, 64) || `passkey-${index + 1}`,
        name: normalizeString(item.name, `Passkey ${index + 1}`, 80) || `Passkey ${index + 1}`,
        detail: normalizeString(item.detail, '', 160),
      };
    });
  }

  if (Array.isArray(userNotifications.events)) {
    base.user.notifications.events = userNotifications.events.map((raw, index) => {
      const item = asObject(raw);
      return {
        id: normalizeString(item.id, `event-${index + 1}`, 64) || `event-${index + 1}`,
        label: normalizeString(item.label, `Event ${index + 1}`, 96) || `Event ${index + 1}`,
        email: normalizeBoolean(item.email, false),
        inApp: normalizeBoolean(item.inApp, false),
        slack: normalizeBoolean(item.slack, false),
      };
    });
  }
  base.user.notifications.quietHoursEnabled = normalizeBoolean(userNotifications.quietHoursEnabled, base.user.notifications.quietHoursEnabled);
  base.user.notifications.startTime = normalizeString(userNotifications.startTime, base.user.notifications.startTime, 8);
  base.user.notifications.endTime = normalizeString(userNotifications.endTime, base.user.notifications.endTime, 8);
  base.user.notifications.timezone = normalizeString(userNotifications.timezone, base.user.notifications.timezone, 32);

  base.user.preferences.theme = normalizeTheme(userPreferences.theme, base.user.preferences.theme);
  base.user.preferences.density = normalizeDensity(userPreferences.density, base.user.preferences.density);
  base.user.preferences.fontSize = normalizeFontSize(userPreferences.fontSize, base.user.preferences.fontSize);
  base.user.preferences.reducedMotion = normalizeBoolean(userPreferences.reducedMotion, base.user.preferences.reducedMotion);
  base.user.preferences.highContrast = normalizeBoolean(userPreferences.highContrast, base.user.preferences.highContrast);
  base.user.preferences.keyboardHints = normalizeBoolean(userPreferences.keyboardHints, base.user.preferences.keyboardHints);

  base.user.aiDefaults.preferredProvider = normalizeProvider(userAiDefaults.preferredProvider, base.user.aiDefaults.preferredProvider);
  base.user.aiDefaults.preferredModel = normalizeString(userAiDefaults.preferredModel, base.user.aiDefaults.preferredModel, 128);
  base.user.aiDefaults.fallbackModel = normalizeString(userAiDefaults.fallbackModel, base.user.aiDefaults.fallbackModel, 128);
  base.user.aiDefaults.personalApiKey = normalizeString(userAiDefaults.personalApiKey, base.user.aiDefaults.personalApiKey, 2048);
  base.user.aiDefaults.personalKeyLabel = normalizeString(userAiDefaults.personalKeyLabel, base.user.aiDefaults.personalKeyLabel, 64);
  base.user.aiDefaults.keyLastUsed = normalizeString(userAiDefaults.keyLastUsed, base.user.aiDefaults.keyLastUsed, 64);

  base.user.integrations.githubConnected = normalizeBoolean(userIntegrations.githubConnected, base.user.integrations.githubConnected);
  base.user.integrations.githubUsername = normalizeString(userIntegrations.githubUsername, base.user.integrations.githubUsername, 64);
  base.user.integrations.personalPat = normalizeString(userIntegrations.personalPat, base.user.integrations.personalPat, 2048);

  base.user.privacy.usageTelemetry = normalizeBoolean(userPrivacy.usageTelemetry, base.user.privacy.usageTelemetry);
  base.user.privacy.analyticsLevel = normalizeAnalyticsLevel(userPrivacy.analyticsLevel, base.user.privacy.analyticsLevel);
  base.user.privacy.productEmails = normalizeBoolean(userPrivacy.productEmails, base.user.privacy.productEmails);

  base.user.billing.deployments = Math.round(normalizeNumber(userBilling.deployments, base.user.billing.deployments, 0, 1000000));
  base.user.billing.tokensUsed = Math.round(normalizeNumber(userBilling.tokensUsed, base.user.billing.tokensUsed, 0, 1000000000));
  base.user.billing.apiCalls = Math.round(normalizeNumber(userBilling.apiCalls, base.user.billing.apiCalls, 0, 100000000));
  base.user.billing.estimatedCostUsd = normalizeNumber(userBilling.estimatedCostUsd, base.user.billing.estimatedCostUsd, 0, 1000000);

  if (Array.isArray(userSessions.rows)) {
    base.user.sessions.rows = userSessions.rows.map((raw, index) => {
      const item = asObject(raw);
      return {
        id: normalizeString(item.id, `session-${index + 1}`, 64) || `session-${index + 1}`,
        deviceType: normalizeDeviceType(item.deviceType, 'laptop'),
        name: normalizeString(item.name, `Session ${index + 1}`, 96) || `Session ${index + 1}`,
        location: normalizeString(item.location, '', 96),
        time: normalizeString(item.time, '', 64),
        current: normalizeBoolean(item.current, false),
      };
    });
  }

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

  const userPatch = asObject(patch.user);
  const accountPatch = asObject(userPatch.account);
  if (Object.prototype.hasOwnProperty.call(accountPatch, 'avatarInitials')) {
    next.user.account.avatarInitials = normalizeString(accountPatch.avatarInitials, next.user.account.avatarInitials, 4).toUpperCase();
  }
  if (Object.prototype.hasOwnProperty.call(accountPatch, 'displayName')) {
    next.user.account.displayName = normalizeString(accountPatch.displayName, next.user.account.displayName, 64);
  }
  if (Object.prototype.hasOwnProperty.call(accountPatch, 'roleTitle')) {
    next.user.account.roleTitle = normalizeString(accountPatch.roleTitle, next.user.account.roleTitle, 128);
  }
  if (Object.prototype.hasOwnProperty.call(accountPatch, 'bio')) {
    next.user.account.bio = normalizeString(accountPatch.bio, next.user.account.bio, 512);
  }
  if (Object.prototype.hasOwnProperty.call(accountPatch, 'contactEmail')) {
    next.user.account.contactEmail = normalizeString(accountPatch.contactEmail, next.user.account.contactEmail, 160);
  }
  if (Object.prototype.hasOwnProperty.call(accountPatch, 'language')) {
    next.user.account.language = normalizeString(accountPatch.language, next.user.account.language, 64);
  }
  if (Object.prototype.hasOwnProperty.call(accountPatch, 'timezone')) {
    next.user.account.timezone = normalizeString(accountPatch.timezone, next.user.account.timezone, 64);
  }
  if (Object.prototype.hasOwnProperty.call(accountPatch, 'dateFormat')) {
    next.user.account.dateFormat = normalizeString(accountPatch.dateFormat, next.user.account.dateFormat, 64);
  }
  if (Object.prototype.hasOwnProperty.call(accountPatch, 'numberFormat')) {
    next.user.account.numberFormat = normalizeString(accountPatch.numberFormat, next.user.account.numberFormat, 64);
  }

  const securityPatch = asObject(userPatch.security);
  if (Object.prototype.hasOwnProperty.call(securityPatch, 'mfaEnabled')) {
    next.user.security.mfaEnabled = normalizeBoolean(securityPatch.mfaEnabled, next.user.security.mfaEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(securityPatch, 'recoveryCodes')) {
    next.user.security.recoveryCodes = Math.round(normalizeNumber(securityPatch.recoveryCodes, next.user.security.recoveryCodes, 0, 32));
  }
  if (Array.isArray(securityPatch.passkeys)) {
    next.user.security.passkeys = securityPatch.passkeys.map((raw, index) => {
      const item = asObject(raw);
      return {
        id: normalizeString(item.id, `passkey-${index + 1}`, 64) || `passkey-${index + 1}`,
        name: normalizeString(item.name, `Passkey ${index + 1}`, 80) || `Passkey ${index + 1}`,
        detail: normalizeString(item.detail, '', 160),
      };
    });
  }

  const notificationsPatch = asObject(userPatch.notifications);
  if (Array.isArray(notificationsPatch.events)) {
    next.user.notifications.events = notificationsPatch.events.map((raw, index) => {
      const item = asObject(raw);
      return {
        id: normalizeString(item.id, `event-${index + 1}`, 64) || `event-${index + 1}`,
        label: normalizeString(item.label, `Event ${index + 1}`, 96) || `Event ${index + 1}`,
        email: normalizeBoolean(item.email, false),
        inApp: normalizeBoolean(item.inApp, false),
        slack: normalizeBoolean(item.slack, false),
      };
    });
  }
  if (Object.prototype.hasOwnProperty.call(notificationsPatch, 'quietHoursEnabled')) {
    next.user.notifications.quietHoursEnabled = normalizeBoolean(notificationsPatch.quietHoursEnabled, next.user.notifications.quietHoursEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(notificationsPatch, 'startTime')) {
    next.user.notifications.startTime = normalizeString(notificationsPatch.startTime, next.user.notifications.startTime, 8);
  }
  if (Object.prototype.hasOwnProperty.call(notificationsPatch, 'endTime')) {
    next.user.notifications.endTime = normalizeString(notificationsPatch.endTime, next.user.notifications.endTime, 8);
  }
  if (Object.prototype.hasOwnProperty.call(notificationsPatch, 'timezone')) {
    next.user.notifications.timezone = normalizeString(notificationsPatch.timezone, next.user.notifications.timezone, 32);
  }

  const preferencesPatch = asObject(userPatch.preferences);
  if (Object.prototype.hasOwnProperty.call(preferencesPatch, 'theme')) {
    next.user.preferences.theme = normalizeTheme(preferencesPatch.theme, next.user.preferences.theme);
  }
  if (Object.prototype.hasOwnProperty.call(preferencesPatch, 'density')) {
    next.user.preferences.density = normalizeDensity(preferencesPatch.density, next.user.preferences.density);
  }
  if (Object.prototype.hasOwnProperty.call(preferencesPatch, 'fontSize')) {
    next.user.preferences.fontSize = normalizeFontSize(preferencesPatch.fontSize, next.user.preferences.fontSize);
  }
  if (Object.prototype.hasOwnProperty.call(preferencesPatch, 'reducedMotion')) {
    next.user.preferences.reducedMotion = normalizeBoolean(preferencesPatch.reducedMotion, next.user.preferences.reducedMotion);
  }
  if (Object.prototype.hasOwnProperty.call(preferencesPatch, 'highContrast')) {
    next.user.preferences.highContrast = normalizeBoolean(preferencesPatch.highContrast, next.user.preferences.highContrast);
  }
  if (Object.prototype.hasOwnProperty.call(preferencesPatch, 'keyboardHints')) {
    next.user.preferences.keyboardHints = normalizeBoolean(preferencesPatch.keyboardHints, next.user.preferences.keyboardHints);
  }

  const aiDefaultsPatch = asObject(userPatch.aiDefaults);
  if (Object.prototype.hasOwnProperty.call(aiDefaultsPatch, 'preferredProvider')) {
    next.user.aiDefaults.preferredProvider = normalizeProvider(aiDefaultsPatch.preferredProvider, next.user.aiDefaults.preferredProvider);
  }
  if (Object.prototype.hasOwnProperty.call(aiDefaultsPatch, 'preferredModel')) {
    next.user.aiDefaults.preferredModel = normalizeString(aiDefaultsPatch.preferredModel, next.user.aiDefaults.preferredModel, 128);
  }
  if (Object.prototype.hasOwnProperty.call(aiDefaultsPatch, 'fallbackModel')) {
    next.user.aiDefaults.fallbackModel = normalizeString(aiDefaultsPatch.fallbackModel, next.user.aiDefaults.fallbackModel, 128);
  }
  if (Object.prototype.hasOwnProperty.call(aiDefaultsPatch, 'personalKeyLabel')) {
    next.user.aiDefaults.personalKeyLabel = normalizeString(aiDefaultsPatch.personalKeyLabel, next.user.aiDefaults.personalKeyLabel, 64);
  }
  if (Object.prototype.hasOwnProperty.call(aiDefaultsPatch, 'keyLastUsed')) {
    next.user.aiDefaults.keyLastUsed = normalizeString(aiDefaultsPatch.keyLastUsed, next.user.aiDefaults.keyLastUsed, 64);
  }
  next.user.aiDefaults.personalApiKey = normalizeSecretPatch(next.user.aiDefaults.personalApiKey, aiDefaultsPatch.personalApiKey);

  const userIntegrationsPatch = asObject(userPatch.integrations);
  if (Object.prototype.hasOwnProperty.call(userIntegrationsPatch, 'githubConnected')) {
    next.user.integrations.githubConnected = normalizeBoolean(userIntegrationsPatch.githubConnected, next.user.integrations.githubConnected);
  }
  if (Object.prototype.hasOwnProperty.call(userIntegrationsPatch, 'githubUsername')) {
    next.user.integrations.githubUsername = normalizeString(userIntegrationsPatch.githubUsername, next.user.integrations.githubUsername, 64);
  }
  next.user.integrations.personalPat = normalizeSecretPatch(next.user.integrations.personalPat, userIntegrationsPatch.personalPat);

  const privacyPatch = asObject(userPatch.privacy);
  if (Object.prototype.hasOwnProperty.call(privacyPatch, 'usageTelemetry')) {
    next.user.privacy.usageTelemetry = normalizeBoolean(privacyPatch.usageTelemetry, next.user.privacy.usageTelemetry);
  }
  if (Object.prototype.hasOwnProperty.call(privacyPatch, 'analyticsLevel')) {
    next.user.privacy.analyticsLevel = normalizeAnalyticsLevel(privacyPatch.analyticsLevel, next.user.privacy.analyticsLevel);
  }
  if (Object.prototype.hasOwnProperty.call(privacyPatch, 'productEmails')) {
    next.user.privacy.productEmails = normalizeBoolean(privacyPatch.productEmails, next.user.privacy.productEmails);
  }

  const billingPatch = asObject(userPatch.billing);
  if (Object.prototype.hasOwnProperty.call(billingPatch, 'deployments')) {
    next.user.billing.deployments = Math.round(normalizeNumber(billingPatch.deployments, next.user.billing.deployments, 0, 1000000));
  }
  if (Object.prototype.hasOwnProperty.call(billingPatch, 'tokensUsed')) {
    next.user.billing.tokensUsed = Math.round(normalizeNumber(billingPatch.tokensUsed, next.user.billing.tokensUsed, 0, 1000000000));
  }
  if (Object.prototype.hasOwnProperty.call(billingPatch, 'apiCalls')) {
    next.user.billing.apiCalls = Math.round(normalizeNumber(billingPatch.apiCalls, next.user.billing.apiCalls, 0, 100000000));
  }
  if (Object.prototype.hasOwnProperty.call(billingPatch, 'estimatedCostUsd')) {
    next.user.billing.estimatedCostUsd = normalizeNumber(billingPatch.estimatedCostUsd, next.user.billing.estimatedCostUsd, 0, 1000000);
  }

  const sessionsPatch = asObject(userPatch.sessions);
  if (Array.isArray(sessionsPatch.rows)) {
    next.user.sessions.rows = sessionsPatch.rows.map((raw, index) => {
      const item = asObject(raw);
      return {
        id: normalizeString(item.id, `session-${index + 1}`, 64) || `session-${index + 1}`,
        deviceType: normalizeDeviceType(item.deviceType, 'laptop'),
        name: normalizeString(item.name, `Session ${index + 1}`, 96) || `Session ${index + 1}`,
        location: normalizeString(item.location, '', 96),
        time: normalizeString(item.time, '', 64),
        current: normalizeBoolean(item.current, false),
      };
    });
  }

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
    user: {
      account: {
        avatarInitials: settings.user.account.avatarInitials,
        displayName: settings.user.account.displayName,
        roleTitle: settings.user.account.roleTitle,
        bio: settings.user.account.bio,
        contactEmail: settings.user.account.contactEmail,
        language: settings.user.account.language,
        timezone: settings.user.account.timezone,
        dateFormat: settings.user.account.dateFormat,
        numberFormat: settings.user.account.numberFormat,
      },
      security: {
        mfaEnabled: settings.user.security.mfaEnabled,
        recoveryCodes: settings.user.security.recoveryCodes,
        passkeys: settings.user.security.passkeys.map((passkey) => ({
          id: passkey.id,
          name: passkey.name,
          detail: passkey.detail,
        })),
      },
      notifications: {
        events: settings.user.notifications.events.map((event) => ({
          id: event.id,
          label: event.label,
          email: event.email,
          inApp: event.inApp,
          slack: event.slack,
        })),
        quietHoursEnabled: settings.user.notifications.quietHoursEnabled,
        startTime: settings.user.notifications.startTime,
        endTime: settings.user.notifications.endTime,
        timezone: settings.user.notifications.timezone,
      },
      preferences: {
        theme: settings.user.preferences.theme,
        density: settings.user.preferences.density,
        fontSize: settings.user.preferences.fontSize,
        reducedMotion: settings.user.preferences.reducedMotion,
        highContrast: settings.user.preferences.highContrast,
        keyboardHints: settings.user.preferences.keyboardHints,
      },
      aiDefaults: {
        preferredProvider: settings.user.aiDefaults.preferredProvider,
        preferredModel: settings.user.aiDefaults.preferredModel,
        fallbackModel: settings.user.aiDefaults.fallbackModel,
        hasPersonalApiKey: settings.user.aiDefaults.personalApiKey.length > 0,
        personalKeyLabel: settings.user.aiDefaults.personalKeyLabel,
        keyLastUsed: settings.user.aiDefaults.keyLastUsed,
      },
      integrations: {
        githubConnected: settings.user.integrations.githubConnected,
        githubUsername: settings.user.integrations.githubUsername,
        hasPersonalPat: settings.user.integrations.personalPat.length > 0,
      },
      privacy: {
        usageTelemetry: settings.user.privacy.usageTelemetry,
        analyticsLevel: settings.user.privacy.analyticsLevel,
        productEmails: settings.user.privacy.productEmails,
      },
      billing: {
        deployments: settings.user.billing.deployments,
        tokensUsed: settings.user.billing.tokensUsed,
        apiCalls: settings.user.billing.apiCalls,
        estimatedCostUsd: settings.user.billing.estimatedCostUsd,
      },
      sessions: {
        rows: settings.user.sessions.rows.map((session) => ({
          id: session.id,
          deviceType: session.deviceType,
          name: session.name,
          location: session.location,
          time: session.time,
          current: session.current,
        })),
      },
    },
  };
}

export const DEFAULT_PUBLIC_USER_SETTINGS: PublicUserSettings = toPublicUserSettings(DEFAULT_USER_SETTINGS);
