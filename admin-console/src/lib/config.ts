const DEFAULT_DEV_SESSION_SECRET = 'deplai-admin-local-dev-secret-do-not-use-in-prod';
const DEFAULT_DEV_AUDIT_SECRET = 'deplai-admin-local-audit-secret-do-not-use-in-prod';
const DEFAULT_DEV_MFA_KEY = 'deplai-admin-local-mfa-key-do-not-use-in-prod';

function envString(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export type AdminConfig = {
  enabled: boolean;
  bindHost: string;
  port: number;
  sessionSecret: string;
  auditHmacSecret: string;
  mfaEncryptionKey: string;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  stepUpMinutes: number;
  webauthnRpId: string;
  webauthnRpName: string;
  webauthnOrigin: string;
  isProduction: boolean;
};

let cachedConfig: AdminConfig | null = null;

export function getAdminConfig(): AdminConfig {
  if (cachedConfig) return cachedConfig;

  const isProduction = process.env.NODE_ENV === 'production';
  const sessionSecret = envString('ADMIN_SESSION_SECRET', isProduction ? '' : DEFAULT_DEV_SESSION_SECRET);
  const auditHmacSecret = envString('ADMIN_AUDIT_HMAC_SECRET', isProduction ? '' : DEFAULT_DEV_AUDIT_SECRET);
  const mfaEncryptionKey = envString('ADMIN_MFA_ENCRYPTION_KEY', isProduction ? '' : DEFAULT_DEV_MFA_KEY);
  const bindHost = envString('ADMIN_BIND_HOST', '127.0.0.1');
  const allowUnsafeBind = envBoolean('ADMIN_ALLOW_UNSAFE_BIND', false);

  cachedConfig = {
    enabled: envBoolean('ADMIN_ENABLED', true),
    bindHost,
    port: envNumber('ADMIN_PORT', 3100),
    sessionSecret,
    auditHmacSecret,
    mfaEncryptionKey,
    sessionIdleMinutes: envNumber('ADMIN_SESSION_IDLE_MINUTES', 15),
    sessionAbsoluteHours: envNumber('ADMIN_SESSION_ABSOLUTE_HOURS', 4),
    stepUpMinutes: envNumber('ADMIN_STEP_UP_MINUTES', 5),
    webauthnRpId: envString('ADMIN_WEBAUTHN_RP_ID', 'localhost'),
    webauthnRpName: envString('ADMIN_WEBAUTHN_RP_NAME', 'Deplai Owner Console'),
    webauthnOrigin: envString('ADMIN_WEBAUTHN_ORIGIN', 'http://127.0.0.1:3100'),
    isProduction,
  };

  if (isProduction) {
    validateProductionConfig(cachedConfig, allowUnsafeBind);
  }

  return cachedConfig;
}

function validateProductionConfig(config: AdminConfig, allowUnsafeBind: boolean): void {
  const errors: string[] = [];

  if (!config.enabled) errors.push('ADMIN_ENABLED must be true in production');
  if (!config.sessionSecret || config.sessionSecret === DEFAULT_DEV_SESSION_SECRET) {
    errors.push('ADMIN_SESSION_SECRET must be set to a strong unique value');
  }
  if (!config.auditHmacSecret || config.auditHmacSecret === DEFAULT_DEV_AUDIT_SECRET) {
    errors.push('ADMIN_AUDIT_HMAC_SECRET must be set to a strong unique value');
  }
  if (!config.mfaEncryptionKey || config.mfaEncryptionKey === DEFAULT_DEV_MFA_KEY) {
    errors.push('ADMIN_MFA_ENCRYPTION_KEY must be set to a strong unique value');
  }
  if (config.bindHost === '0.0.0.0' && !allowUnsafeBind) {
    errors.push('ADMIN_BIND_HOST=0.0.0.0 is not allowed in production without ADMIN_ALLOW_UNSAFE_BIND=true');
  }

  if (errors.length > 0) {
    throw new Error(`Admin console startup blocked:\n- ${errors.join('\n- ')}`);
  }
}
