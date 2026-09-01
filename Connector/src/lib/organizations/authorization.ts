import {
  isPermissionKey,
  permissionsForRole,
  type PermissionKey,
} from './permissions';

export type OrganizationScopeType = 'ORGANIZATION' | 'PROJECT' | 'ENVIRONMENT';

export type AuthorizationGrant = {
  organizationId: string;
  roleKey: string;
  scopeType: OrganizationScopeType;
  scopeId: string | null;
  permissionKeys?: readonly string[];
  source?: 'MEMBERSHIP' | 'USER' | 'TEAM';
};

export type AuthorizationResource = {
  organizationId: string;
  scopeType?: OrganizationScopeType;
  scopeId?: string | null;
  projectId?: string | null;
  environmentKind?: string | null;
};

export type AuthorizationInput = {
  principalOrganizationId: string;
  membershipStatus: string;
  membershipRoleKey: string;
  grants?: readonly AuthorizationGrant[];
  action: PermissionKey;
  resource: AuthorizationResource;
};

function scopeRank(scopeType: OrganizationScopeType): number {
  if (scopeType === 'ENVIRONMENT') return 3;
  if (scopeType === 'PROJECT') return 2;
  return 1;
}

function grantMatchesResource(grant: AuthorizationGrant, resource: AuthorizationResource): boolean {
  if (grant.organizationId !== resource.organizationId) return false;
  if (grant.scopeType === 'ORGANIZATION') return grant.scopeId == null || grant.scopeId === resource.organizationId;
  if (grant.scopeType === 'PROJECT') {
    return Boolean(grant.scopeId && (grant.scopeId === resource.projectId || (
      resource.scopeType === 'PROJECT' && grant.scopeId === resource.scopeId
    )));
  }
  return Boolean(
    grant.scopeId
    && resource.scopeType === 'ENVIRONMENT'
    && grant.scopeId === resource.scopeId,
  );
}

function grantPermissions(grant: AuthorizationGrant): readonly PermissionKey[] {
  const builtIn = permissionsForRole(grant.roleKey);
  if (builtIn.length > 0) return builtIn;
  return (grant.permissionKeys || []).filter(isPermissionKey);
}

export function authorizeResolved(input: AuthorizationInput): boolean {
  if (input.membershipStatus !== 'ACTIVE') return false;
  if (!input.principalOrganizationId || input.principalOrganizationId !== input.resource.organizationId) return false;

  const membershipGrant: AuthorizationGrant = {
    organizationId: input.principalOrganizationId,
    roleKey: input.membershipRoleKey,
    scopeType: 'ORGANIZATION',
    scopeId: input.principalOrganizationId,
    source: 'MEMBERSHIP',
  };
  const matching = [membershipGrant, ...(input.grants || [])]
    .filter((grant) => grantMatchesResource(grant, input.resource));
  const specificRank = Math.max(...matching.map((grant) => scopeRank(grant.scopeType)));
  const effective = matching.filter((grant) => scopeRank(grant.scopeType) === specificRank);

  const isProductionMutation = input.resource.scopeType === 'ENVIRONMENT'
    && String(input.resource.environmentKind || '').toLowerCase() === 'production'
    && ['deployment.create', 'deployment.rollback'].includes(input.action);
  if (isProductionMutation && specificRank < scopeRank('ENVIRONMENT')) {
    const baseRoles = effective.map((grant) => grant.roleKey);
    if (baseRoles.includes('DEVELOPER')) return false;
  }

  return effective.some((grant) => grantPermissions(grant).includes(input.action));
}

export function tenantResourceIsVisible(
  principalOrganizationId: string,
  resourceOrganizationId: string,
): boolean {
  return Boolean(principalOrganizationId && principalOrganizationId === resourceOrganizationId);
}
