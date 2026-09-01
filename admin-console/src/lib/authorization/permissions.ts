export const ADMIN_PERMISSIONS = [
  'ADMIN_USER_READ',
  'ADMIN_USER_WRITE',
  'ADMIN_ORG_READ',
  'ADMIN_ORG_WRITE',
  'ADMIN_PROJECT_READ',
  'ADMIN_PROJECT_WRITE',
  'ADMIN_BILLING_READ',
  'ADMIN_BILLING_WRITE',
  'ADMIN_REFUND_CREATE',
  'ADMIN_SECURITY_READ',
  'ADMIN_KEY_REVOKE',
  'ADMIN_AUDIT_READ',
  'ADMIN_SETTINGS_WRITE',
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

const OWNER_PERMISSIONS = new Set<AdminPermission>(ADMIN_PERMISSIONS);

const STEP_UP_SCOPES = {
  'user.disable': 'ADMIN_USER_WRITE',
  'user.delete': 'ADMIN_USER_WRITE',
  'user.email_change': 'ADMIN_USER_WRITE',
  'user.revoke_sessions': 'ADMIN_USER_WRITE',
  'project.delete': 'ADMIN_PROJECT_WRITE',
  'api_key.revoke_all': 'ADMIN_KEY_REVOKE',
  'refund.create': 'ADMIN_REFUND_CREATE',
  'subscription.cancel': 'ADMIN_BILLING_WRITE',
  'credits.adjust': 'ADMIN_BILLING_WRITE',
  'org.destructive': 'ADMIN_ORG_WRITE',
  'owner.credentials': 'ADMIN_SETTINGS_WRITE',
} as const;

export type StepUpScope = keyof typeof STEP_UP_SCOPES;

export function ownerHasPermission(permission: AdminPermission): boolean {
  return OWNER_PERMISSIONS.has(permission);
}

export function permissionForStepUp(scope: StepUpScope): AdminPermission {
  return STEP_UP_SCOPES[scope];
}

export function requiresStepUp(scope: StepUpScope): boolean {
  return scope in STEP_UP_SCOPES;
}
