export const ORGANIZATION_ROLE_KEYS = [
  'OWNER',
  'ADMIN',
  'DEVOPS',
  'DEVELOPER',
  'SECURITY',
  'BILLING_ADMIN',
  'VIEWER',
] as const;

export type OrganizationRoleKey = (typeof ORGANIZATION_ROLE_KEYS)[number];

export const PERMISSION_DEFINITIONS = [
  ['organization.read', 'Organization', 'View organization details'],
  ['organization.update', 'Organization', 'Update organization settings'],
  ['organization.delete', 'Organization', 'Schedule organization deletion'],
  ['organization.transfer', 'Organization', 'Transfer organization ownership'],
  ['member.read', 'Members', 'View members and invitations'],
  ['member.invite', 'Members', 'Invite and resend invitations'],
  ['member.remove', 'Members', 'Suspend or remove members'],
  ['member.role.update', 'Members', 'Change member roles'],
  ['team.read', 'Teams', 'View teams'],
  ['team.create', 'Teams', 'Create teams'],
  ['team.update', 'Teams', 'Update teams'],
  ['team.delete', 'Teams', 'Delete teams'],
  ['team.member.manage', 'Teams', 'Manage team membership'],
  ['role.read', 'Roles', 'View roles and permissions'],
  ['role.create', 'Roles', 'Create custom roles'],
  ['role.update', 'Roles', 'Update custom roles'],
  ['role.delete', 'Roles', 'Delete custom roles'],
  ['role.assign', 'Roles', 'Assign roles and scopes'],
  ['project.read', 'Projects', 'View assigned projects'],
  ['project.create', 'Projects', 'Create projects'],
  ['project.update', 'Projects', 'Update projects'],
  ['project.delete', 'Projects', 'Delete projects'],
  ['repository.read', 'Repositories', 'View repository metadata'],
  ['repository.connect', 'Repositories', 'Connect repositories'],
  ['repository.disconnect', 'Repositories', 'Disconnect repositories'],
  ['agent.run', 'Agents', 'Start agent runs'],
  ['agent.read', 'Agents', 'View agent runs'],
  ['agent.cancel', 'Agents', 'Cancel agent runs'],
  ['ui_customization.run', 'Agents', 'Run UI customization'],
  ['ui_customization.read', 'Agents', 'View UI customization output'],
  ['security.scan.read', 'Security', 'View security scans'],
  ['security.scan.run', 'Security', 'Run security scans'],
  ['security.findings.read', 'Security', 'View findings'],
  ['security.findings.remediate', 'Security', 'Remediate findings'],
  ['security.policy.read', 'Security', 'View security policies'],
  ['security.policy.manage', 'Security', 'Manage security policies'],
  ['security.exception.create', 'Security', 'Request security exceptions'],
  ['security.exception.approve', 'Security', 'Approve security exceptions'],
  ['deployment.read', 'Deployments', 'View deployments and logs'],
  ['deployment.create', 'Deployments', 'Create deployments'],
  ['deployment.cancel', 'Deployments', 'Cancel deployments'],
  ['deployment.rollback', 'Deployments', 'Roll back deployments'],
  ['deployment.approve', 'Deployments', 'Approve governed deployments'],
  ['environment.read', 'Environments', 'View environments'],
  ['environment.create', 'Environments', 'Create environments'],
  ['environment.update', 'Environments', 'Update environments'],
  ['environment.delete', 'Environments', 'Delete environments'],
  ['cloud_account.read', 'Cloud', 'View masked cloud account metadata'],
  ['cloud_account.connect', 'Cloud', 'Connect cloud accounts'],
  ['cloud_account.disconnect', 'Cloud', 'Disconnect cloud accounts'],
  ['cloud_account.use', 'Cloud', 'Use approved cloud accounts'],
  ['secret.read_metadata', 'Secrets', 'View secret metadata only'],
  ['secret.create', 'Secrets', 'Create secrets'],
  ['secret.update', 'Secrets', 'Rotate or update secrets'],
  ['secret.delete', 'Secrets', 'Delete secrets'],
  ['ai_provider.read', 'AI', 'View provider configuration metadata'],
  ['ai_provider.configure', 'AI', 'Configure providers and BYOK'],
  ['ai_provider.use', 'AI', 'Use approved providers'],
  ['billing.read', 'Billing', 'View subscription and transactions'],
  ['billing.manage', 'Billing', 'Manage subscription and billing profile'],
  ['billing.refund', 'Billing', 'Request refunds'],
  ['invoice.read', 'Billing', 'View invoices'],
  ['audit.read', 'Audit', 'View organization audit events'],
  ['audit.export', 'Audit', 'Export organization audit events'],
  ['webhook.read', 'Integrations', 'View outgoing webhooks'],
  ['webhook.manage', 'Integrations', 'Manage outgoing webhooks'],
  ['notification.read', 'Integrations', 'View notification policies'],
  ['notification.manage', 'Integrations', 'Manage notification policies'],
  ['usage.read', 'Usage', 'View usage and quotas'],
  ['quota.manage', 'Usage', 'Manage quota policies'],
] as const;

export type PermissionKey = (typeof PERMISSION_DEFINITIONS)[number][0];

const ALL_PERMISSIONS = PERMISSION_DEFINITIONS.map(([key]) => key) as PermissionKey[];
const READ_PERMISSIONS = ALL_PERMISSIONS.filter((permission) =>
  permission.endsWith('.read') || permission === 'secret.read_metadata',
);

const ROLE_PERMISSION_MATRIX: Record<OrganizationRoleKey, readonly PermissionKey[]> = {
  OWNER: ALL_PERMISSIONS,
  ADMIN: ALL_PERMISSIONS.filter((permission) =>
    permission !== 'organization.delete' && permission !== 'organization.transfer',
  ),
  DEVOPS: [
    'organization.read', 'member.read', 'team.read', 'role.read',
    'project.read', 'project.create', 'project.update',
    'repository.read', 'repository.connect', 'repository.disconnect',
    'agent.read', 'agent.run', 'agent.cancel',
    'security.scan.read', 'security.findings.read',
    'deployment.read', 'deployment.create', 'deployment.cancel', 'deployment.rollback', 'deployment.approve',
    'environment.read', 'environment.create', 'environment.update', 'environment.delete',
    'cloud_account.read', 'cloud_account.connect', 'cloud_account.disconnect', 'cloud_account.use',
    'secret.read_metadata', 'secret.create', 'secret.update', 'secret.delete',
    'ai_provider.read', 'ai_provider.use', 'usage.read', 'audit.read',
  ],
  DEVELOPER: [
    'organization.read', 'member.read', 'team.read', 'role.read',
    'project.read', 'project.create', 'project.update',
    'repository.read', 'repository.connect',
    'agent.read', 'agent.run', 'agent.cancel',
    'ui_customization.read', 'ui_customization.run',
    'security.scan.read', 'security.scan.run', 'security.findings.read',
    'deployment.read', 'deployment.create', 'deployment.cancel', 'deployment.rollback',
    'environment.read', 'cloud_account.read', 'cloud_account.use',
    'secret.read_metadata', 'ai_provider.read', 'ai_provider.use', 'usage.read',
  ],
  SECURITY: [
    'organization.read', 'member.read', 'team.read', 'role.read', 'project.read', 'repository.read',
    'security.scan.read', 'security.scan.run', 'security.findings.read', 'security.findings.remediate',
    'security.policy.read', 'security.policy.manage',
    'security.exception.create', 'security.exception.approve',
    'deployment.read', 'deployment.approve', 'environment.read',
    'cloud_account.read', 'secret.read_metadata', 'ai_provider.read', 'audit.read', 'audit.export', 'usage.read',
  ],
  BILLING_ADMIN: [
    'organization.read', 'member.read', 'billing.read', 'billing.manage', 'billing.refund',
    'invoice.read', 'usage.read',
  ],
  VIEWER: READ_PERMISSIONS.filter((permission) =>
    !['billing.read', 'invoice.read', 'audit.read'].includes(permission),
  ),
};

export const BUILTIN_ROLES = [
  ['OWNER', 'Owner', 'Full organization control, including ownership and deletion.'],
  ['ADMIN', 'Admin', 'Broad management without owner-only destructive controls.'],
  ['DEVOPS', 'DevOps', 'Deployments, environments, cloud access, and operations.'],
  ['DEVELOPER', 'Developer', 'Projects, repositories, agents, scans, and non-production delivery.'],
  ['SECURITY', 'Security', 'Security findings, policies, exceptions, approvals, and audit.'],
  ['BILLING_ADMIN', 'Billing Admin', 'Subscription, usage, invoices, transactions, and refunds.'],
  ['VIEWER', 'Viewer', 'Read-only access to assigned non-sensitive resources.'],
] as const satisfies readonly [OrganizationRoleKey, string, string][];

export function permissionsForRole(roleKey: string): readonly PermissionKey[] {
  return ROLE_PERMISSION_MATRIX[roleKey as OrganizationRoleKey] || [];
}

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_DEFINITIONS.some(([key]) => key === value);
}

export function permissionGroups() {
  const groups = new Map<string, Array<{ key: PermissionKey; description: string }>>();
  for (const [key, group, description] of PERMISSION_DEFINITIONS) {
    const items = groups.get(group) || [];
    items.push({ key, description });
    groups.set(group, items);
  }
  return Array.from(groups, ([name, permissions]) => ({ name, permissions }));
}
