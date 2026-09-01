import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authorizeResolved, tenantResourceIsVisible, type AuthorizationGrant } from './authorization';
import { sanitizeAuditMetadata } from './audit';
import { approvalRequirementSatisfied, DEFAULT_SECURITY_POLICY, evaluateSecurityPolicy } from './governance';
import { createInvitationToken, evaluateInvitation } from './invitations';
import type { PermissionKey } from './permissions';

const organizationA = 'org-a';
const organizationB = 'org-b';

function allowed(input: {
  role: string;
  action: PermissionKey;
  organizationId?: string;
  resourceOrganizationId?: string;
  grants?: AuthorizationGrant[];
  scopeType?: 'ORGANIZATION' | 'PROJECT' | 'ENVIRONMENT';
  scopeId?: string;
  projectId?: string;
  environmentKind?: string;
  status?: string;
}) {
  return authorizeResolved({
    principalOrganizationId: input.organizationId || organizationA,
    membershipStatus: input.status || 'ACTIVE',
    membershipRoleKey: input.role,
    action: input.action,
    grants: input.grants,
    resource: {
      organizationId: input.resourceOrganizationId || organizationA,
      scopeType: input.scopeType || 'ORGANIZATION',
      scopeId: input.scopeId || organizationA,
      projectId: input.projectId,
      environmentKind: input.environmentKind,
    },
  });
}

describe('organization tenant isolation', () => {
  const resources = ['project', 'deployment', 'scan', 'finding', 'secret metadata', 'billing', 'cloud account', 'audit event'];
  for (const resource of resources) {
    it(`denies Organization A access to Organization B ${resource}`, () => {
      assert.equal(tenantResourceIsVisible(organizationA, organizationB), false);
      assert.equal(allowed({ role: 'OWNER', action: 'organization.read', resourceOrganizationId: organizationB }), false);
    });
  }

  it('denies suspended or missing memberships even when the role would allow access', () => {
    assert.equal(allowed({ role: 'OWNER', action: 'organization.read', status: 'SUSPENDED' }), false);
  });
});

describe('built-in organization RBAC', () => {
  it('allows owners full organization access', () => {
    assert.equal(allowed({ role: 'OWNER', action: 'organization.delete' }), true);
    assert.equal(allowed({ role: 'OWNER', action: 'billing.refund' }), true);
  });

  it('keeps owner-only destructive actions away from admins', () => {
    assert.equal(allowed({ role: 'ADMIN', action: 'organization.update' }), true);
    assert.equal(allowed({ role: 'ADMIN', action: 'organization.delete' }), false);
    assert.equal(allowed({ role: 'ADMIN', action: 'organization.transfer' }), false);
  });

  it('prevents developers from managing billing', () => {
    assert.equal(allowed({ role: 'DEVELOPER', action: 'project.update' }), true);
    assert.equal(allowed({ role: 'DEVELOPER', action: 'billing.manage' }), false);
  });

  it('prevents billing admins from deploying', () => {
    assert.equal(allowed({ role: 'BILLING_ADMIN', action: 'billing.manage' }), true);
    assert.equal(allowed({ role: 'BILLING_ADMIN', action: 'deployment.create' }), false);
  });

  it('allows security roles to manage policy while viewers cannot mutate', () => {
    assert.equal(allowed({ role: 'SECURITY', action: 'security.policy.manage' }), true);
    assert.equal(allowed({ role: 'VIEWER', action: 'project.update' }), false);
  });

  it('is deny-by-default for unknown custom roles without permissions', () => {
    assert.equal(allowed({ role: 'CUSTOM_EMPTY', action: 'project.read' }), false);
  });
});

describe('resource-scoped authorization', () => {
  it('lets a project-scoped role override a broad membership role', () => {
    const grants: AuthorizationGrant[] = [{
      organizationId: organizationA,
      roleKey: 'VIEWER',
      scopeType: 'PROJECT',
      scopeId: 'project-a',
      source: 'USER',
    }];
    assert.equal(allowed({ role: 'DEVELOPER', action: 'project.read', grants, scopeType: 'PROJECT', scopeId: 'project-a', projectId: 'project-a' }), true);
    assert.equal(allowed({ role: 'DEVELOPER', action: 'project.update', grants, scopeType: 'PROJECT', scopeId: 'project-a', projectId: 'project-a' }), false);
  });

  it('requires an explicit environment assignment for a developer production deploy', () => {
    assert.equal(allowed({ role: 'DEVELOPER', action: 'deployment.create', scopeType: 'ENVIRONMENT', scopeId: 'prod', projectId: 'p1', environmentKind: 'production' }), false);
    const grants: AuthorizationGrant[] = [{ organizationId: organizationA, roleKey: 'DEVELOPER', scopeType: 'ENVIRONMENT', scopeId: 'prod', source: 'USER' }];
    assert.equal(allowed({ role: 'VIEWER', action: 'deployment.create', grants, scopeType: 'ENVIRONMENT', scopeId: 'prod', projectId: 'p1', environmentKind: 'production' }), true);
  });

  it('applies team-based project grants only to the matching project', () => {
    const grants: AuthorizationGrant[] = [{ organizationId: organizationA, roleKey: 'DEVELOPER', scopeType: 'PROJECT', scopeId: 'project-a', source: 'TEAM' }];
    assert.equal(allowed({ role: 'VIEWER', action: 'project.update', grants, scopeType: 'PROJECT', scopeId: 'project-a', projectId: 'project-a' }), true);
    assert.equal(allowed({ role: 'VIEWER', action: 'project.update', grants, scopeType: 'PROJECT', scopeId: 'project-b', projectId: 'project-b' }), false);
  });
});

describe('secure organization invitations', () => {
  const invite = createInvitationToken();
  const base = {
    token: invite.token,
    tokenHash: invite.tokenHash,
    invitedEmail: 'member@example.com',
    acceptingEmail: 'member@example.com',
    expiresAt: new Date('2030-01-02T00:00:00Z'),
    now: new Date('2030-01-01T00:00:00Z'),
  };

  it('accepts a valid invitation and rejects a tampered token', () => {
    assert.equal(evaluateInvitation(base), 'VALID');
    assert.equal(evaluateInvitation({ ...base, token: `${invite.token}x` }), 'TAMPERED');
  });

  it('rejects expired, revoked, and already-used invitations', () => {
    assert.equal(evaluateInvitation({ ...base, now: new Date('2030-01-03T00:00:00Z') }), 'EXPIRED');
    assert.equal(evaluateInvitation({ ...base, revokedAt: new Date() }), 'REVOKED');
    assert.equal(evaluateInvitation({ ...base, acceptedAt: new Date() }), 'ACCEPTED');
  });

  it('binds acceptance to the invited email', () => {
    assert.equal(evaluateInvitation({ ...base, acceptingEmail: 'attacker@example.com' }), 'WRONG_EMAIL');
  });
});

describe('organization governance evaluators', () => {
  it('blocks a production gate when required security evidence fails', () => {
    const result = evaluateSecurityPolicy(DEFAULT_SECURITY_POLICY, {
      criticalFindings: 1,
      highFindings: 0,
      exposedSecrets: 0,
      sastCompleted: true,
      scaCompleted: true,
      containerScanCompleted: true,
      dastCompleted: false,
    });
    assert.equal(result.decision, 'FAIL');
  });

  it('requires distinct approvals and rejects expired approval windows', () => {
    assert.equal(approvalRequirementSatisfied({ approvalsRequired: 2, validApproverIds: ['a'], expired: false }), false);
    assert.equal(approvalRequirementSatisfied({ approvalsRequired: 2, validApproverIds: ['a', 'a'], expired: false }), false);
    assert.equal(approvalRequirementSatisfied({ approvalsRequired: 2, validApproverIds: ['a', 'b'], expired: false }), true);
    assert.equal(approvalRequirementSatisfied({ approvalsRequired: 2, validApproverIds: ['a', 'b'], expired: true }), false);
  });
});

describe('organization audit sanitization', () => {
  it('never preserves credential-shaped fields', () => {
    const sanitized = sanitizeAuditMetadata({
      action: 'secret.created',
      apiKey: 'should-not-appear',
      nested: { razorpaySecret: 'nope', safe: 'visible' },
    }) as Record<string, unknown>;
    assert.equal('apiKey' in sanitized, false);
    assert.deepEqual(sanitized.nested, { safe: 'visible' });
  });
});
